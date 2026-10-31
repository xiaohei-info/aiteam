import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = path.join(repoRoot, 'src-tauri')
const deployedAgentHttpOrigins = new Set(['http://121.40.78.201:8783'])

const forbiddenPermissionPatterns = [
  /^\*$/,
  /^core:default$/,
  /^dialog:default$/,
  /^notification:default$/,
  /^store:default$/,
  /^shell:/,
  /^process:/,
  /^fs:/,
]

function assertSafePermissionIdentifier(identifier, source) {
  assert.equal(typeof identifier, 'string', `${source}: permission identifier must be a string`)
  for (const pattern of forbiddenPermissionPatterns) {
    assert.doesNotMatch(identifier, pattern, `${source}: dangerous broad permission ${identifier}`)
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function assertSafeHttpScope(scope, source) {
  assert.equal(typeof scope, 'string', `${source}: HTTP allow scope must be a string`)
  const match = scope.match(/^(https?):\/\/([^/]+)(?:\/.*)?$/i)
  assert.ok(match, `${source}: HTTP allow scope must use an explicit http(s) origin: ${scope}`)

  const [, protocol, authority] = match
  assert.ok(!authority.includes('@'), `${source}: credentials are forbidden in HTTP allow scopes`)

  let hostname
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    assert.notEqual(closingBracket, -1, `${source}: malformed IPv6 HTTP allow scope: ${scope}`)
    hostname = authority.slice(1, closingBracket)
    const port = authority.slice(closingBracket + 1)
    assert.match(port, /^(?::(?:\*|\d+))?$/, `${source}: malformed HTTP allow port: ${scope}`)
  } else {
    const [host, ...portParts] = authority.split(':')
    hostname = host
    assert.ok(portParts.length <= 1, `${source}: malformed HTTP allow origin: ${scope}`)
    if (portParts.length === 1) {
      assert.match(portParts[0], /^(?:\*|\d+)$/, `${source}: malformed HTTP allow port: ${scope}`)
    }
  }

  assert.ok(hostname && !hostname.includes('*'), `${source}: wildcard hosts are forbidden: ${scope}`)
  if (protocol.toLowerCase() === 'http') {
    const origin = `${protocol.toLowerCase()}://${authority}`
    assert.ok(
      isLoopbackHostname(hostname) || deployedAgentHttpOrigins.has(origin),
      `${source}: plaintext HTTP is restricted to loopback or the explicit TEST control-plane origins: ${scope}`,
    )
  }
}

function parseCsp(csp) {
  const directives = new Map()
  for (const segment of csp.split(';')) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const [name, ...sources] = tokens
    assert.ok(!directives.has(name), `duplicate CSP directive: ${name}`)
    directives.set(name, sources)
  }
  return directives
}

function assertExactDirective(directives, name, expected) {
  assert.deepEqual(directives.get(name), expected, `CSP ${name} must be ${expected.join(' ')}`)
}

function assertSafeConnectSource(source) {
  if (source === "'self'" || source === 'ipc:' || source === 'http://ipc.localhost') return
  if (source.startsWith('https://') || source.startsWith('wss://')) {
    const url = new URL(source.replace(/:\*/g, ':65535').replace(/\/\*\*?$/, '/'))
    assert.ok(!url.hostname.includes('*'), `CSP connect-src cannot contain a wildcard host: ${source}`)
    return
  }
  if (source.startsWith('http://') || source.startsWith('ws://')) {
    const normalized = source.replace(/^ws:/, 'http:').replace(/:\*/g, ':65535').replace(/\/\*\*?$/, '/')
    const url = new URL(normalized)
    assert.ok(
      isLoopbackHostname(url.hostname) || deployedAgentHttpOrigins.has(url.origin),
      `CSP plaintext connect-src is restricted to loopback or the explicit TEST control-plane origins: ${source}`,
    )
    return
  }
  assert.fail(`unsupported CSP connect-src entry: ${source}`)
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'))
}

const capabilityDirectory = path.join(tauriRoot, 'capabilities')
const capabilityFiles = (await readdir(capabilityDirectory))
  .filter((name) => name.endsWith('.json'))
  .sort()

assert.ok(capabilityFiles.length > 0, 'at least one Tauri capability file is required')

const expectedNotificationPermissions = [
  'notification:allow-is-permission-granted',
  'notification:allow-notify',
  'notification:allow-request-permission',
]
const notificationPermissions = []

for (const filename of capabilityFiles) {
  const relative = `src-tauri/capabilities/${filename}`
  const capability = await readJson(relative)
  assert.ok(Array.isArray(capability.permissions), `${relative}: permissions must be an array`)

  for (const permission of capability.permissions) {
    const identifier = typeof permission === 'string' ? permission : permission?.identifier
    assertSafePermissionIdentifier(identifier, relative)

    if (identifier.startsWith('notification:')) notificationPermissions.push(identifier)

    if (!identifier.startsWith('http:')) continue
    assert.equal(typeof permission, 'object', `${relative}: HTTP permissions must carry an explicit allow scope`)
    assert.ok(Array.isArray(permission.allow) && permission.allow.length > 0, `${relative}: HTTP allow scope is required`)
    for (const entry of permission.allow) assertSafeHttpScope(entry?.url, relative)
  }
}

assert.deepEqual(
  notificationPermissions.sort(),
  expectedNotificationPermissions,
  'notification capability must stay limited to permission check, user-initiated request, and send',
)

const tauriConfig = await readJson('src-tauri/tauri.conf.json')
const security = tauriConfig?.app?.security
assert.equal(typeof security?.csp, 'string', 'Tauri CSP must be enabled')
assert.notEqual(security?.dangerousDisableAssetCspModification, true, 'Tauri CSP asset modification must stay enabled')

const directives = parseCsp(security.csp)
assertExactDirective(directives, 'default-src', ["'self'"])
assertExactDirective(directives, 'base-uri', ["'self'"])
assertExactDirective(directives, 'object-src', ["'none'"])
assertExactDirective(directives, 'frame-ancestors', ["'none'"])
assertExactDirective(directives, 'form-action', ["'self'"])
assertExactDirective(directives, 'script-src', ["'self'"])

for (const [name, sources] of directives) {
  assert.ok(!sources.includes('*'), `CSP ${name} cannot contain an unrestricted wildcard`)
  assert.ok(!sources.includes("'unsafe-eval'"), `CSP ${name} cannot enable unsafe-eval`)
  if (name !== 'style-src') {
    assert.ok(!sources.includes("'unsafe-inline'"), `CSP unsafe-inline is only allowed for styles, not ${name}`)
  }
}

const connectSources = directives.get('connect-src')
assert.ok(connectSources?.length, 'CSP connect-src is required')
for (const source of connectSources) assertSafeConnectSource(source)

if (security.assetProtocol?.enable) {
  assert.deepEqual(
    security.assetProtocol.scope,
    ['$APPDATA/*/*/file/**'],
    'asset protocol scope must remain restricted to cached conversation files',
  )
}

const [packageJson, cargoToml] = await Promise.all([
  readJson('package.json'),
  readFile(path.join(tauriRoot, 'Cargo.toml'), 'utf8'),
])
const jsPackages = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
}
for (const packageName of [
  '@tauri-apps/plugin-fs',
  '@tauri-apps/plugin-process',
  '@tauri-apps/plugin-shell',
]) {
  assert.ok(!(packageName in jsPackages), `dangerous Tauri plugin dependency is forbidden: ${packageName}`)
}
assert.doesNotMatch(cargoToml, /^tauri-plugin-(?:fs|process|shell)\s*=/m, 'dangerous Rust Tauri plugin dependency is forbidden')

const rustEntry = await readFile(path.join(tauriRoot, 'src/lib.rs'), 'utf8')
assert.doesNotMatch(rustEntry, /mod db|db::commands|rusqlite::Connection/, 'legacy SQLite commands must not be exposed to the WebView')
assert.doesNotMatch(cargoToml, /^rusqlite\s*=/m, 'inactive SQLite runtime dependency must stay removed')
assert.doesNotMatch(rustEntry, /http_request_binary/, 'undocumented binary preview transport must stay removed')

assert.doesNotMatch(rustEntry, /headers:\s*HashMap/, 'binary preview must not accept arbitrary WebView headers')

console.log(`[tauri-security] checked ${capabilityFiles.length} capability file(s), CSP, asset scope, and plugin dependencies`)
