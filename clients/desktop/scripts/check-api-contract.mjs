import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { documentedRoutes, isDocumentedRequest } from '../src/api/agent/contract.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spec = JSON.parse(readFileSync(path.join(root, 'docs/api.json'), 'utf8'))
const excluded = new Set(['GET /api/agent/grants/snapshots'])
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])
const operations = Object.entries(spec.paths).flatMap(([route, item]) => Object.entries(item)
  .filter(([verb]) => verbs.has(verb))
  .map(([verb, operation]) => ({ route, verb: verb.toUpperCase(), operation, callers: new Set() })))

assert.ok(operations.length > 0, '8783 OpenAPI must contain operations')
assert.deepEqual(new Set(documentedRoutes.map(([verb, route]) => `${verb} ${route}`)),
  new Set(operations.map(({ verb, route }) => `${verb} ${route}`).filter(key => !excluded.has(key))),
  'runtime routes must match the checked-in 8783 contract, excluding snapshots')
for (const { verb, route } of operations) {
  const sample = route.replace(/\{[^}]+\}/g, 'opaque-id')
  assert.equal(isDocumentedRequest(verb, sample), !excluded.has(`${verb} ${route}`), `${verb} ${route}`)
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : []
  })
}

// Transport-owning modules. Everything else must go through the documented client so
// `isDocumentedRequest` stays the single gate for the 8783 Agent/Manager contract.
const networkFiles = new Set([
  'src/api/agent/client.ts', // documented client itself
  'src/api/agent/events.ts', // SSE streaming transport
  'src/lib/fileCache.ts', // asset:// local attachment reads, not HTTP
  // User-configured NAS / Manager knowledge service: its paths are not part of the
  // 8783 Agent contract, so it keeps a dedicated, credentials-scoped transport.
  'src/pages/KnowledgeBase/api.ts',
  // Local office-editor middleware and map assets served by Vite / the asset protocol.
  'src/scene/office/officeMap/loadOfficeMap.ts',
])
let callsites = 0
for (const file of sources(path.join(root, 'src'))) {
  const relative = path.relative(root, file)
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = new Map()
  const functions = new Map()
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer)
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isUnionTypeNode(node.type)) declarations.set(node.name.text, node.type)
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body)
    ts.forEachChild(node, collect)
  }
  collect(source)

  function expand(node, depth = 0) {
    assert.ok(node && depth < 10, `${relative}: cannot resolve API path`)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
    if (ts.isLiteralTypeNode(node)) return expand(node.literal, depth + 1)
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(type => expand(type, depth + 1))
    if (ts.isConditionalExpression(node)) return [...expand(node.whenTrue, depth + 1), ...expand(node.whenFalse, depth + 1)]
    if (ts.isIdentifier(node)) return expand(declarations.get(node.text), depth + 1)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'encodeURIComponent') return ['*']
      const body = functions.get(node.expression.text)
      const returned = body?.statements.find(ts.isReturnStatement)
      if (returned?.expression) return expand(returned.expression, depth + 1)
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((values, span) => values.flatMap(value =>
        expand(span.expression, depth + 1).map(part => `${value}${part}${span.literal.text}`)), [node.head.text])
    }
    throw new Error(`${relative}: unsupported API path expression ${node.getText(source)}`)
  }

  function record(verb, template, node) {
    const parts = template.split('/')
    const matches = operations.filter(operation => {
      const expected = operation.route.split('/')
      return verb === operation.verb && expected.length === parts.length
        && expected.every((part, i) => part.startsWith('{') ? parts[i] === '*' || Boolean(parts[i]) : part === parts[i])
    })
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    assert.ok(matches.length, `${relative}:${line}: undocumented ${verb} ${template}`)
    for (const operation of matches) {
      assert.ok(!excluded.has(`${verb} ${operation.route}`), `${relative}:${line}: snapshot call is forbidden`)
      operation.callers.add(`${relative}:${line}`)
    }
    callsites++
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      if (/^(?:fetch|fetchImpl|\w+\.fetch|\w+\.fetchImpl)$/.test(callee)) {
        assert.ok(networkFiles.has(relative), `${relative}: direct HTTP must use the documented service client`)
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'request') {
        const options = node.arguments[0]
        assert.ok(options && ts.isObjectLiteralExpression(options), `${relative}: request options must be auditable`)
        const properties = new Map(options.properties.filter(property => ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)).map(property => [property.name.getText(source), ts.isPropertyAssignment(property) ? property.initializer : property.name]))
        const verb = properties.has('method') ? expand(properties.get('method'))[0] : 'GET'
        for (const template of expand(properties.get('path'))) record(verb, template, node)
      }
    }
    if (ts.isImportDeclaration(node)) {
      const dependency = node.moduleSpecifier.text
      assert.ok(!/api\/manager|axios|hermes/.test(dependency), `${relative}: obsolete API import ${dependency}`)
      if (dependency === '@tauri-apps/plugin-http') assert.equal(relative, 'src/api/agent/runtime.ts')
    }
    if (ts.isNewExpression(node)) assert.ok(!/XMLHttpRequest|WebSocket|EventSource/.test(node.expression.getText(source)), `${relative}: undocumented transport`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  // SSE has a separate streaming transport, but uses the same method/path guard.
  if (relative === 'src/api/agent/events.ts') {
    for (const template of expand(declarations.get('path'))) record('GET', template, declarations.get('path'))
    assert.match(source.text, /isDocumentedRequest\('GET', path\)/)
  }
}

// Native startup requests are limited to documented health and contract metadata.
const nativeFile = 'src-tauri/src/agent.rs'
const native = readFileSync(path.join(root, nativeFile), 'utf8').split('#[cfg(test)]')[0]
for (const match of native.matchAll(/\.(get|post|put|patch|delete)\(format!\("\{url\}([^"\n]+)"\)\)/g)) {
  const verb = match[1].toUpperCase()
  const operation = operations.find(item => item.verb === verb && item.route === match[2])
  assert.ok(operation && !excluded.has(`${verb} ${match[2]}`), `undocumented native request: ${match[0]}`)
  operation.callers.add(`${nativeFile}:${native.slice(0, match.index).split('\n').length}`)
  callsites++
}

const rust = readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8')
assert.doesNotMatch(rust, /http_request_binary|HttpState|reqwest::Client/, 'native generic HTTP bridge must stay removed')
const assets = readFileSync(path.join(root, 'src/lib/fileCache.ts'), 'utf8')
assert.match(assets, /await resolveCachedFile\(file\.rel_path\)/)
assert.match(assets, /assetUrl\.startsWith\('asset:\/\/localhost\/'\)/)

if (process.argv.includes('--write-report')) {
  const rows = operations.map(({ verb, route, operation, callers }) => {
    const state = excluded.has(`${verb} ${route}`) ? '按用户要求排除' : callers.size ? '已核对调用' : '文档允许，当前未调用'
    return `| ${verb} | \`${route}\` | ${operation.operationId ?? ''} | ${state} | ${[...callers].map(caller => `\`${caller}\``).join('<br>')} |`
  })
  writeFileSync(path.join(root, 'docs/api-audit.md'), `# 8783 接口核对表\n\n唯一 HTTP 契约：[8783 OpenAPI](http://121.40.78.201:8783/openapi.json)，本地副本为 [api.json](api.json)，获取日期 2026-09-10。\n\n覆盖 ${operations.length} 组请求方法与路径；快照读取继续排除；授权同步已接入登录与会话恢复，其余 ${documentedRoutes.length} 组均来自该文档。未调用的接口不会为了补齐列表而自动发请求。桌面端接口分流见 [本机 Agent 集成](agent-sidecar.md)。\n\n核对范围：页面、store、API 封装、SSE、附件下载、浏览器代理和原生请求。原生启动仅访问本机 healthz/readyz，并读取 openapi.json 核验包版本；openapi.json 是契约元数据。asset:// 本地文件读取、Tauri 文件和凭证命令不是服务端 HTTP 接口。分发包内部服务间通信不由 WebView 发起；本次已同步 Agent reconciliation v2、运行中消息快照和事实状态能力。\n\n已移除：Manager 封装与类型、任意知识预览 URL 下载、原生 http_request_binary 通道、消息附件 URL 直连、无契约的模拟技能 API、旧 multipart 上传支持。知识文档远程预览不可用，本地文件预览保留。\n\n运行 \`pnpm check:api-contract\` 核对全量文档方法/路径、全部 request 调用点与旁路传输；更新代码后使用 \`pnpm check:api-contract --write-report\` 重新生成此表。\n\n| 方法 | 路径 | operationId | 客户端状态 | 调用位置 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`)
}
console.log(`[api-contract] ${operations.length} documented operations, ${documentedRoutes.length} allowed, ${excluded.size} excluded; ${callsites} request paths checked`)
