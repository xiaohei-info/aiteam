import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createSafeRequestMetadata, sanitizeLogValue } from '../src/api/requestLogging.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(repoRoot, 'src')
const rustRoot = path.join(repoRoot, 'src-tauri', 'src')
const requestLoggerFile = 'src/api/requestLogging.ts'

async function collectFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(absolute, extensions)
    return extensions.has(path.extname(entry.name)) ? [absolute] : []
  }))
  return nested.flat()
}

function isConsoleCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  return node.expression.expression.getText() === 'console'
}

const forbiddenLogSources = /\b(?:authorization|cookie|cookies|jwt|password|passwd|requestBody|token)\b|\b(?:config|event|options|request|response)\.(?:data|headers|body)\b|JSON\.stringify/i
const strictBoundaryFiles = /^(?:src\/api\/(?!requestLogging\.ts)|src\/pages\/Login\/index\.tsx$|src\/stores\/(?:agentAuth|auth)\.ts$|src\/lib\/socket\.ts$)/

const violations = []
for (const absolute of await collectFiles(sourceRoot, new Set(['.ts', '.tsx']))) {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/')
  const sourceText = await readFile(absolute, 'utf8')
  const sourceFile = ts.createSourceFile(
    relative,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  function visit(node) {
    if (isConsoleCall(node)) {
      const callText = node.getText(sourceFile)
      if (relative !== requestLoggerFile && strictBoundaryFiles.test(relative)) {
        violations.push(`${relative}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} direct console call in request/auth boundary`)
      } else if (forbiddenLogSources.test(callText)) {
        violations.push(`${relative}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1} potentially sensitive console argument`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

const rustLogPattern = /(?:println|eprintln|dbg|trace|debug|info|warn|error)!\s*\(([\s\S]*?)\)\s*;/g
for (const absolute of await collectFiles(rustRoot, new Set(['.rs']))) {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/')
  const sourceText = await readFile(absolute, 'utf8')
  for (const match of sourceText.matchAll(rustLogPattern)) {
    if (!forbiddenLogSources.test(match[1])) continue
    const line = sourceText.slice(0, match.index).split('\n').length
    violations.push(`${relative}:${line} potentially sensitive Rust log argument`)
  }
}

assert.deepEqual(violations, [], `sensitive logging regression detected:\n${violations.join('\n')}`)

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature'
const password = 'correct-horse-battery-staple'
const cookie = 'session=secret-cookie-value'
const metadata = createSafeRequestMetadata({
  method: 'post',
  url: `https://account:${password}@aifred.cn/api/sessions/${jwt}?access_token=${jwt}`,
  hasBody: true,
  headers: { Authorization: `Bearer ${jwt}`, Cookie: cookie },
  body: { password },
})
const serialized = JSON.stringify(metadata)

for (const secret of [jwt, password, cookie, 'Bearer']) {
  assert.ok(!serialized.includes(secret), `safe request metadata leaked ${secret}`)
}
assert.deepEqual(metadata, {
  method: 'POST',
  origin: 'https://aifred.cn',
  url: 'https://aifred.cn/api/sessions/:redacted?<redacted>',
  path: '/api/sessions/:redacted',
  hasQuery: true,
  hasBody: true,
})

console.log('[sensitive-logs] request logging regression checks passed')

const safePayload = sanitizeLogValue({
  data: { token: jwt, nested: { password, api_key: 'private-key' }, items: [1, 2, 3, 4, 5] },
  query: { limit: 25, account: 'private-account' },
})
const payloadText = JSON.stringify(safePayload)
for (const secret of [jwt, password, 'private-key', 'private-account']) {
  assert.ok(!payloadText.includes(secret), 'parameters/results must redact credentials')
}
assert.match(payloadText, /"limit":25/)
assert.match(payloadText, /\[\+2 items\]/)
