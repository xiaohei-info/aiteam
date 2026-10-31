#!/usr/bin/env node
// Bake an enterprise Agent config into the packaged sidecar.
//
// The shipped src-tauri/resources/agent is a template: it points at
// https://manager.example.com with empty public keys, so the packaged Agent refuses
// to start and the desktop only reports an opaque BACKEND_HEALTH_TIMEOUT. This script
// validates a supplied production/test env file, copies it (and its referenced JWKS)
// into the package, and refreshes manifest.json — the manifest hash is also the cache
// key for the copied config directory, so it must change with the config.
import assert from 'node:assert/strict'
import { createHash, createPublicKey } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LAUNCHER_OWNED = ['AITEAM_AGENT_DATA_DIR', 'AITEAM_AGENT_SPA_ROOT', 'AITEAM_AGENT_PORT_FILE']
const FORBIDDEN = /(?:^|_)(?:API_KEY|APIKEY|PASSWORD|PASSWD|TOKEN|SECRET|SECRET_KEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|CREDENTIAL|CREDENTIALS)$/u

export function parseEnterpriseEnv(text, source) {
  const values = new Map()
  for (const [index, original] of text.split(/\r?\n/u).entries()) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line
    const separator = assignment.indexOf('=')
    assert.ok(separator > 0, `${source}:${index + 1} 必须是 KEY=VALUE`)
    const key = assignment.slice(0, separator).trim()
    assert.ok(!values.has(key), `${source}:${index + 1} 重复定义了 ${key}`)
    let value = assignment.slice(separator + 1).trim()
    const quote = value[0]
    if (quote === '"' || quote === "'") {
      assert.ok(value.length >= 2 && value.endsWith(quote), `${source}:${index + 1} 的引号未闭合`)
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function parseUrl(value, source, name = 'AITEAM_MANAGER_URL') {
  try {
    return new URL(value)
  } catch {
    assert.fail(`${source}: ${name} 不是合法 URL：${value}`)
  }
}

export function assertEnterpriseConfig(values, source) {
  const value = key => values.get(key) ?? ''
  for (const [key, entry] of values) {
    if (!entry) continue
    assert.ok(!FORBIDDEN.test(key.toUpperCase()), `${source}: 运行包配置不得包含密钥字段 ${key}`)
    assert.ok(!LAUNCHER_OWNED.includes(key), `${source}: ${key} 必须由桌面宿主提供，不能固化进运行包`)
  }
  const environment = value('AITEAM_ENV')
  assert.ok(['production', 'test'].includes(environment), `${source}: AITEAM_ENV 必须是 production 或 test`)
  const managerUrl = value('AITEAM_MANAGER_URL')
  assert.ok(managerUrl, `${source}: 缺少 AITEAM_MANAGER_URL`)
  const manager = parseUrl(managerUrl, source)
  assert.ok(['http:', 'https:'].includes(manager.protocol) && !manager.username && !manager.password && !manager.search && !manager.hash, `${source}: AITEAM_MANAGER_URL 必须是无凭据、无查询参数的 HTTP(S) 地址`)
  // 网关模式：会话转发到该远端 Agent，并携带成员令牌；只允许裸 origin。未配置时本机 Agent 自己执行会话。
  const upstreamUrl = value('AITEAM_AGENT_UPSTREAM_URL')
  const upstream = upstreamUrl ? parseUrl(upstreamUrl, source, 'AITEAM_AGENT_UPSTREAM_URL') : undefined
  if (upstream) {
    assert.ok(['http:', 'https:'].includes(upstream.protocol) && !upstream.username && !upstream.password && !upstream.search && !upstream.hash && upstream.pathname === '/', `${source}: AITEAM_AGENT_UPSTREAM_URL 必须是不带路径、凭据和查询参数的 HTTP(S) origin`)
  }
  const devAuth = value('AITEAM_AGENT_DEV_AUTH').toLowerCase() === 'true'
  assert.equal(value('AITEAM_AGENT_SANDBOX_READY').toLowerCase(), 'true', `${source}: 需要 AITEAM_AGENT_SANDBOX_READY=true`)
  assert.equal(value('AITEAM_AGENT_LOCAL_ONLY').toLowerCase(), 'true', `${source}: 需要 AITEAM_AGENT_LOCAL_ONLY=true`)
  const host = (value('HOST') || '127.0.0.1').toLowerCase()
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host), `${source}: HOST 必须是回环地址`)
  assert.ok(!value('AITEAM_AGENT_ALLOWED_ORIGINS').split(',').some(origin => origin.trim() === '*'), `${source}: 不允许通配 CORS 来源`)

  const jwksJson = value('AITEAM_AGENT_JWKS_JSON')
  const jwksPath = value('AITEAM_AGENT_JWKS_PATH')
  assert.ok(!(jwksJson && jwksPath), `${source}: AITEAM_AGENT_JWKS_JSON 与 AITEAM_AGENT_JWKS_PATH 必须二选一`)
  if (environment === 'production') {
    assert.equal(devAuth, false, `${source}: 生产配置不允许 AITEAM_AGENT_DEV_AUTH=true`)
    assert.equal(manager.protocol, 'https:', `${source}: 生产配置的 AITEAM_MANAGER_URL 必须使用 HTTPS`)
    if (upstream) assert.equal(upstream.protocol, 'https:', `${source}: 生产配置的 AITEAM_AGENT_UPSTREAM_URL 必须使用 HTTPS`)
    assert.equal(value('AITEAM_AGENT_JWT_ISSUER'), managerUrl, `${source}: 生产配置的 AITEAM_AGENT_JWT_ISSUER 必须与 AITEAM_MANAGER_URL 逐字相同`)
    assert.ok(value('AITEAM_AGENT_JWT_AUDIENCE'), `${source}: 缺少 AITEAM_AGENT_JWT_AUDIENCE`)
    assert.ok(jwksJson || jwksPath, `${source}: 生产配置缺少企业公共 JWKS（AITEAM_AGENT_JWKS_JSON 或 AITEAM_AGENT_JWKS_PATH）`)
    assert.ok(value('AITEAM_SKILL_SIGNING_PUBLIC_KEY') || value('AITEAM_SKILL_SIGNING_PUBLIC_KEYS'), `${source}: 生产配置缺少技能验签公钥`)
  }
  const skillKey = value('AITEAM_SKILL_SIGNING_PUBLIC_KEY')
  if (skillKey) {
    assert.ok(value('AITEAM_SKILL_SIGNING_KEY_ID'), `${source}: AITEAM_SKILL_SIGNING_PUBLIC_KEY 必须与 AITEAM_SKILL_SIGNING_KEY_ID 同时提供`)
    assert.doesNotThrow(() => createPublicKey({ key: Buffer.from(skillKey, 'base64'), format: 'der', type: 'spki' }), `${source}: AITEAM_SKILL_SIGNING_PUBLIC_KEY 必须是 base64 SPKI 公钥`)
  }
  return { environment, jwksPath, jwksJson }
}

// The Agent rejects unknown JWKS members, so publish only the canonical public
// shape (same normalization as the server-side package builder).
export function normalizePublicJwks(text, source) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    assert.fail(`${source}: JWKS 必须是合法 JSON`)
  }
  assert.ok(document && !Array.isArray(document) && Array.isArray(document.keys) && document.keys.length > 0, `${source}: JWKS 必须包含非空 keys`)
  assert.ok(Object.keys(document).every(name => name === 'keys'), `${source}: JWKS 只允许出现 keys 成员`)
  const privateMembers = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']
  const allowed = new Set(['kty', 'alg', 'kid', 'n', 'e', 'use'])
  const seen = new Set()
  const keys = document.keys.map(key => {
    assert.ok(key && typeof key === 'object' && !Array.isArray(key) && Object.keys(key).every(name => allowed.has(name)), `${source}: JWKS 只能包含 RSA RS256 公钥字段`)
    assert.ok(key.kty === 'RSA' && key.alg === 'RS256' && (key.use === undefined || key.use === 'sig') && typeof key.kid === 'string' && key.kid && typeof key.n === 'string' && typeof key.e === 'string', `${source}: JWKS 只能包含 RSA RS256 公钥`)
    assert.ok(!privateMembers.some(member => Object.hasOwn(key, member)), `${source}: JWKS 不得包含私钥字段`)
    assert.ok(!seen.has(key.kid), `${source}: JWKS 的 kid 重复：${key.kid}`)
    seen.add(key.kid)
    // A malformed key would otherwise only surface as an Agent refusal at launch.
    assert.doesNotThrow(() => createPublicKey({ key, format: 'jwk' }), `${source}: JWKS 的 ${key.kid} 不是可信 RSA 公钥`)
    return { kty: 'RSA', alg: 'RS256', kid: key.kid, n: key.n, e: key.e, ...(key.use === undefined ? {} : { use: 'sig' }) }
  })
  return { keys }
}

// Values may contain whitespace/#/quotes once JSON is inlined, so mirror the
// server-side builder's quoting rules instead of appending raw text.
function setEnvValue(text, key, value) {
  const encoded = /[\s#"']/u.test(value) ? JSON.stringify(value) : value
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'mu')
  return pattern.test(text) ? text.replace(pattern, `$1${encoded}`) : `${text.trimEnd()}\n${key}=${encoded}\n`
}

function readManifest(agent) {
  try {
    return JSON.parse(readFileSync(path.join(agent, 'manifest.json'), 'utf8'))
  } catch {
    assert.fail(`${agent}/manifest.json 缺失或不是合法 JSON；请先运行 pnpm agent:import <artifact>。`)
  }
}

// manifest.json is also the cache key for the copied config directory, so every
// config file must be re-hashed and the configured flag set by the same command.
export function refreshManifest(agent, manifest) {
  const keep = (manifest.files ?? []).filter(item => !String(item.path).startsWith('config/'))
  const configFiles = readdirSync(path.join(agent, 'config')).sort().map(name => `config/${name}`)
  const files = keep.concat(configFiles.map(relative => {
    const bytes = readFileSync(path.join(agent, relative))
    return { path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { ...manifest, configured: true, config_source: 'provided', files }
}

function main() {
  const input = process.argv[2]
  if (!input || input.startsWith('--')) {
    console.error('用法: pnpm agent:configure <企业公共配置 agent.env>\n将配置（及其配套公共 JWKS）写入随包 Agent 并刷新 manifest.json，然后重新打包。')
    process.exitCode = 1
    return
  }
  const agent = process.env.AITEAM_AGENT_DIR
    ? `${path.resolve(process.env.AITEAM_AGENT_DIR)}${path.sep}`
    : fileURLToPath(new URL('../src-tauri/resources/agent/', import.meta.url))
  const source = path.resolve(input)
  assert.ok(existsSync(source) && lstatSync(source).isFile(), `配置不存在或不是普通文件：${source}`)
  const text = readFileSync(source, 'utf8')
  const values = parseEnterpriseEnv(text, source)
  const { environment, jwksPath, jwksJson } = assertEnterpriseConfig(values, source)

  let packagedText = text
  if (jwksPath) {
    assert.ok(!path.isAbsolute(jwksPath) && !jwksPath.split(/[\\/]/).includes('..'), `${source}: JWKS 路径必须是相对路径且不含 ..`)
    const jwksSource = path.join(path.dirname(source), jwksPath)
    assert.ok(existsSync(jwksSource), `${source}: 找不到配套公钥文件 ${jwksSource}`)
    const normalized = normalizePublicJwks(readFileSync(jwksSource, 'utf8'), jwksSource)
    // Match the server-side builder: one canonical public key file name.
    writeFileSync(path.join(agent, 'config', 'manager-jwks.json'), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
    packagedText = setEnvValue(packagedText, 'AITEAM_AGENT_JWKS_PATH', 'manager-jwks.json')
  }
  if (jwksJson) {
    packagedText = setEnvValue(packagedText, 'AITEAM_AGENT_JWKS_JSON', JSON.stringify(normalizePublicJwks(jwksJson, source)))
  }
  const configPath = path.join(agent, 'config', 'agent.env')
  writeFileSync(configPath, packagedText, { mode: 0o600 })
  chmodSync(configPath, 0o600)
  const manifestPath = path.join(agent, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(refreshManifest(agent, readManifest(agent)), null, 2)}\n`)
  console.log(`[agent-configure] 已写入随包配置：env=${environment}、manager=${values.get('AITEAM_MANAGER_URL')}、configured=true`)
  console.log('[agent-configure] 下一步：pnpm agent:check && pnpm check:agent-package && pnpm tauri:build:mac:installer')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
