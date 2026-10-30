import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { agentConfigFromCommand, describeConfig, resolveProfile, sameFile } from '../scripts/dev-env.mjs'

// A complete production profile in a temp checkout; `overrides` replace env values,
// `tamperKey` edits the public key before it is written.
function productionDir(overrides: Record<string, string> = {}, tamperKey?: (key: Record<string, unknown>) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiteam-dev-env-'))
  const config = path.join(dir, 'config/agent')
  mkdirSync(config, { recursive: true })
  const key: Record<string, unknown> = {
    ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }),
    kid: 'tenant:1',
    alg: 'RS256',
    use: 'sig',
  }
  tamperKey?.(key)
  writeFileSync(path.join(config, 'production-jwks.json'), JSON.stringify({ keys: [key] }))
  const values: Record<string, string> = {
    AITEAM_ENV: 'production',
    AITEAM_AGENT_LOCAL_ONLY: 'true',
    AITEAM_AGENT_SANDBOX_READY: 'true',
    AITEAM_MANAGER_URL: 'https://manager.acme.test',
    AITEAM_AGENT_JWT_ISSUER: 'https://manager.acme.test',
    AITEAM_AGENT_JWT_AUDIENCE: 'aiteam-agent',
    AITEAM_AGENT_UPSTREAM_URL: 'https://agent.acme.test',
    AITEAM_AGENT_JWKS_PATH: 'production-jwks.json',
    AITEAM_SKILL_SIGNING_PUBLIC_KEY: generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    AITEAM_SKILL_SIGNING_KEY_ID: 'skill-1',
    ...overrides,
  }
  writeFileSync(path.join(config, 'production.env'), `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`)
  return dir
}

function inTempDir(dir: string, run: () => void) {
  try {
    run()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('测试环境使用入库的 taiyi 测试配置并通过校验', () => {
  const profile = resolveProfile('test')
  assert.equal(profile.environment, 'test')
  assert.ok(profile.configPath.endsWith(path.join('config', 'agent', 'taiyi-test.env')))
  assert.ok(profile.managerUrl.startsWith('http'))
  assert.ok(profile.upstreamUrl.startsWith('http'))
})

test('未知环境名被拒绝', () => {
  assert.throws(() => resolveProfile('staging'), /未知环境/)
})

test('生产环境缺少配置时给出模板指引，不会回退到测试配置', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiteam-dev-env-'))
  inTempDir(dir, () => assert.throws(() => resolveProfile('prod', dir), /production\.env\.example/))
})

test('生产环境配置完整时通过校验', () => {
  const dir = productionDir()
  inTempDir(dir, () => {
    const profile = resolveProfile('prod', dir)
    assert.equal(profile.environment, 'production')
    assert.equal(profile.managerUrl, 'https://manager.acme.test')
    assert.equal(profile.upstreamUrl, 'https://agent.acme.test')
  })
})

test('生产环境拒绝 example 占位地址', () => {
  const dir = productionDir({ AITEAM_MANAGER_URL: 'https://manager.example.com', AITEAM_AGENT_JWT_ISSUER: 'https://manager.example.com' })
  inTempDir(dir, () => assert.throws(() => resolveProfile('prod', dir), /example 占位地址/))
})

test('生产环境拒绝 http 与 issuer 不一致', () => {
  const insecure = productionDir({ AITEAM_MANAGER_URL: 'http://manager.acme.test', AITEAM_AGENT_JWT_ISSUER: 'http://manager.acme.test' })
  inTempDir(insecure, () => assert.throws(() => resolveProfile('prod', insecure), /HTTPS/))
  const mismatch = productionDir({ AITEAM_AGENT_JWT_ISSUER: 'https://manager.acme.test/' })
  inTempDir(mismatch, () => assert.throws(() => resolveProfile('prod', mismatch), /ISSUER/))
})

test('环境名与 AITEAM_ENV 不一致时拒绝', () => {
  const dir = productionDir({ AITEAM_ENV: 'test' })
  inTempDir(dir, () => assert.throws(() => resolveProfile('prod', dir), /AITEAM_ENV/))
})

test('公钥 JWKS 含 Agent 不接受的字段时拒绝', () => {
  const dir = productionDir({}, key => { key.x5t = 'abc' })
  inTempDir(dir, () => assert.throws(() => resolveProfile('prod', dir), /JWKS/))
})

test('从宿主启动命令还原 --config，路径可以含空格', () => {
  const command = '/r/runtime/node --import /r/tsx/index.mjs /r/bin/start-agent.mjs --config /Users/x/Library/Application Support/com.aiteam.desktop/agent-config/abc/agent.env --host 127.0.0.1 --port 0 --data-dir /d'
  assert.equal(agentConfigFromCommand(command), '/Users/x/Library/Application Support/com.aiteam.desktop/agent-config/abc/agent.env')
  assert.equal(agentConfigFromCommand('node vite.js'), undefined)
})

test('sameFile 把空路径当作不同文件，不会解析成当前目录', () => {
  assert.equal(sameFile('', ''), false)
  assert.equal(sameFile(undefined, process.cwd()), false)
  assert.equal(sameFile(process.cwd(), '.'), true)
})

test('describeConfig 区分入库的环境配置、随包配置、应用数据目录配置和自定义配置', () => {
  const appData = path.join(homedir(), 'Library/Application Support/com.aiteam.desktop')
  assert.match(describeConfig(resolveProfile('test').configPath), /pnpm dev:test/)
  assert.match(describeConfig(path.join(appData, 'agent-config/abc/agent.env')), /随包配置/)
  assert.match(describeConfig(path.join(appData, 'agent.env')), /应用数据目录/)
  assert.match(describeConfig('/tmp/other.env'), /自定义配置/)
})
