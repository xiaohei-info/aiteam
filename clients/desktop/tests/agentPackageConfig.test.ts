import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentConfigState, checkAgentPackage, parseAgentEnv } from '../scripts/check-agent.mjs'

const CONFIGURE = fileURLToPath(new URL('../scripts/configure-agent-package.mjs', import.meta.url))

const TEMPLATE = [
  '# AI Team Agent sidecar configuration.',
  'AITEAM_ENV=production',
  'AITEAM_MANAGER_URL=https://manager.example.com',
  'AITEAM_AGENT_JWKS_JSON=',
  'AITEAM_SKILL_SIGNING_PUBLIC_KEY=',
  '',
].join('\n')

function entry(directory: string, relative: string, content: Buffer | string) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
  writeFileSync(path.join(directory, relative), bytes)
  return { path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function fixture(config: string = TEMPLATE) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiteam-package-test-'))
  const files = [
    entry(directory, 'runtime/node', 'node executable bytes'),
    entry(directory, 'bin/start-agent.mjs', 'launcher'),
    entry(directory, 'dist/main.js', 'runtime'),
    entry(directory, 'node_modules/tsx/dist/esm/index.mjs', 'tsx'),
    entry(directory, 'config/agent.env', config),
  ]
  const manifest = {
    schema_version: 1,
    product: 'aiteam-agent',
    version: '0.1.0',
    target: 'darwin-arm64',
    configured: false,
    config_source: 'template',
    capabilities: { reconciliation: 2, active_run_snapshots: true, facts_state: true },
    files,
  }
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { directory, manifest }
}

test('template packages are reported as unconfigured instead of passing silently', () => {
  const f = fixture()
  try {
    assert.equal(checkAgentPackage(f.directory).configured, false)
    assert.deepEqual(agentConfigState(f.directory), {
      environment: 'production',
      managerUrl: 'https://manager.example.com',
      hasJwks: false,
      hasSkillKey: false,
    })
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

test('a config edited without refreshing manifest.json is rejected', () => {
  const f = fixture()
  try {
    const complete = 'AITEAM_ENV=production\nAITEAM_MANAGER_URL=https://aifred.cn\nAITEAM_AGENT_JWKS_PATH=manager-jwks.json\nAITEAM_SKILL_SIGNING_PUBLIC_KEY=abc\n'
    writeFileSync(path.join(f.directory, 'config/agent.env'), complete)
    // manifest.json is also the copied-config cache key, so an unnoticed edit would be ignored.
    assert.throws(() => checkAgentPackage(f.directory), /modified without refreshing manifest\.json/)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

test('a manifest whose configured flag disagrees with its config source is rejected', () => {
  const f = fixture()
  try {
    f.manifest.configured = true
    writeFileSync(path.join(f.directory, 'manifest.json'), `${JSON.stringify(f.manifest)}\n`)
    assert.throws(() => checkAgentPackage(f.directory), /disagrees with its config/)
    f.manifest.configured = false
    f.manifest.config_source = 'enterprise'
    writeFileSync(path.join(f.directory, 'manifest.json'), `${JSON.stringify(f.manifest)}\n`)
    assert.throws(() => checkAgentPackage(f.directory), /disagrees with its config/)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

test('packaged config parsing ignores comments, blanks and surrounding quotes', () => {
  const values = parseAgentEnv('# comment\n\nAITEAM_ENV=production\nAITEAM_AGENT_JWKS_PATH="manager-jwks.json"\nAITEAM_AGENT_JWT_AUDIENCE=\nnot-an-assignment\n')
  assert.equal(values.get('AITEAM_ENV'), 'production')
  assert.equal(values.get('AITEAM_AGENT_JWKS_PATH'), 'manager-jwks.json')
  assert.equal(values.get('AITEAM_AGENT_JWT_AUDIENCE'), '')
  assert.equal(values.has('not-an-assignment'), false)
})

test('an enterprise package keeps its configured flag and reports public key presence', () => {
  const config = 'AITEAM_ENV=production\nAITEAM_MANAGER_URL=https://aifred.cn\nAITEAM_AGENT_JWKS_PATH=manager-jwks.json\nAITEAM_SKILL_SIGNING_PUBLIC_KEY=c21va2Utb25seQ==\n'
  const f = fixture(config)
  try {
    f.manifest.configured = true
    f.manifest.config_source = 'enterprise'
    f.manifest.files = f.manifest.files.filter(item => item.path !== 'config/agent.env')
    f.manifest.files.push(entry(f.directory, 'config/agent.env', config))
    writeFileSync(path.join(f.directory, 'manifest.json'), `${JSON.stringify(f.manifest)}\n`)
    assert.equal(checkAgentPackage(f.directory).configured, true)
    assert.deepEqual(agentConfigState(f.directory), {
      environment: 'production',
      managerUrl: 'https://aifred.cn',
      hasJwks: true,
      hasSkillKey: true,
    })
    assert.match(readFileSync(path.join(f.directory, 'config/agent.env'), 'utf8'), /AITEAM_MANAGER_URL=https:\/\/aifred\.cn/)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})

function enterpriseConfigFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiteam-enterprise-config-'))
  const { n, e } = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
  writeFileSync(path.join(directory, 'manager-jwks.json'), `${JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', kid: 'tenant-1', n, e, use: 'sig' }] })}\n`)
  const skillKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  writeFileSync(path.join(directory, 'agent.env'), [
    'AITEAM_ENV=production',
    'AITEAM_AGENT_LOCAL_ONLY=true',
    'AITEAM_AGENT_SANDBOX_READY=true',
    'HOST=127.0.0.1',
    'AITEAM_MANAGER_URL=https://aifred.cn',
    'AITEAM_AGENT_JWT_ISSUER=https://aifred.cn',
    'AITEAM_AGENT_JWT_AUDIENCE=aiteam-agent',
    'AITEAM_AGENT_JWKS_PATH=manager-jwks.json',
    `AITEAM_SKILL_SIGNING_PUBLIC_KEY=${skillKey}`,
    'AITEAM_SKILL_SIGNING_KEY_ID=skills-2026-current',
    '',
  ].join('\n'))
  return directory
}

function configure(packageDirectory: string, configPath: string) {
  return execFileSync(process.execPath, [CONFIGURE, configPath], {
    env: { ...process.env, AITEAM_AGENT_DIR: packageDirectory },
    encoding: 'utf8',
  })
}

test('agent:configure bakes a validated enterprise config and refreshes the manifest', () => {
  const f = fixture()
  const config = enterpriseConfigFixture()
  try {
    const output = configure(f.directory, path.join(config, 'agent.env'))
    assert.match(output, /configured=true/)
    // The copied manifest keeps the packaged tree self-consistent, so the desktop
    // resolves the new config instead of a cached template copy.
    assert.equal(checkAgentPackage(f.directory).configured, true)
    assert.deepEqual(agentConfigState(f.directory), {
      environment: 'production',
      managerUrl: 'https://aifred.cn',
      hasJwks: true,
      hasSkillKey: true,
    })
    const manifest = JSON.parse(readFileSync(path.join(f.directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.config_source, 'provided')
    assert.deepEqual(manifest.files.map((item: { path: string }) => item.path).filter((name: string) => name.startsWith('config/')), ['config/agent.env', 'config/manager-jwks.json'])
    const jwks = readFileSync(path.join(f.directory, 'config/manager-jwks.json'), 'utf8')
    assert.match(jwks, /"kid": "tenant-1"/)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})

test('agent:configure refuses an incomplete enterprise config without touching the package', () => {
  const f = fixture()
  const config = enterpriseConfigFixture()
  try {
    const incomplete = readFileSync(path.join(config, 'agent.env'), 'utf8')
      .split('\n')
      .filter(line => !line.startsWith('AITEAM_SKILL_SIGNING_'))
      .join('\n')
    writeFileSync(path.join(config, 'agent.env'), incomplete)
    assert.throws(() => configure(f.directory, path.join(config, 'agent.env')), /缺少技能验签公钥/)
    assert.equal(readFileSync(path.join(f.directory, 'config/agent.env'), 'utf8'), TEMPLATE)
    assert.equal(checkAgentPackage(f.directory).configured, false)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})

test('agent:configure rejects smuggled upstream secrets and private keys', () => {
  const f = fixture()
  const config = enterpriseConfigFixture()
  try {
    const text = readFileSync(path.join(config, 'agent.env'), 'utf8')
    writeFileSync(path.join(config, 'agent.env'), `${text}MANAGER_API_KEY=leaked\n`)
    assert.throws(() => configure(f.directory, path.join(config, 'agent.env')), /不得包含密钥字段/)
    assert.equal(readFileSync(path.join(f.directory, 'config/agent.env'), 'utf8'), TEMPLATE)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})

test('agent:configure publishes only canonical public JWKS members', () => {
  const f = fixture()
  const config = enterpriseConfigFixture()
  try {
    const { n, e } = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
    // Unknown members and non-signing keys are rejected by the Agent's JWKS parser.
    writeFileSync(path.join(config, 'manager-jwks.json'), JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', kid: 'tenant-1', n, e, key_ops: ['verify'] }] }))
    assert.throws(() => configure(f.directory, path.join(config, 'agent.env')), /只能包含 RSA RS256 公钥字段/)
    writeFileSync(path.join(config, 'manager-jwks.json'), JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', kid: 'tenant-1', n, e, use: 'enc' }] }))
    assert.throws(() => configure(f.directory, path.join(config, 'agent.env')), /只能包含 RSA RS256 公钥/)
    writeFileSync(path.join(config, 'manager-jwks.json'), JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', kid: 'tenant-1', n, e, use: 'sig' }] }))
    configure(f.directory, path.join(config, 'agent.env'))
    const packaged = JSON.parse(readFileSync(path.join(f.directory, 'config/manager-jwks.json'), 'utf8'))
    assert.deepEqual(Object.keys(packaged.keys[0]).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use'])
    assert.match(readFileSync(path.join(f.directory, 'config/agent.env'), 'utf8'), /^AITEAM_AGENT_JWKS_PATH=manager-jwks\.json$/mu)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})

test('agent:configure supports an inline public JWKS and keeps it public-only', () => {
  const f = fixture()
  const config = enterpriseConfigFixture()
  try {
    const { n, e } = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })
    const inline = JSON.stringify({ keys: [{ kty: 'RSA', alg: 'RS256', kid: 'tenant-1', n, e }] })
    const text = readFileSync(path.join(config, 'agent.env'), 'utf8')
      .replace('AITEAM_AGENT_JWKS_PATH=manager-jwks.json', `AITEAM_AGENT_JWKS_JSON=${inline}`)
    writeFileSync(path.join(config, 'agent.env'), text)
    configure(f.directory, path.join(config, 'agent.env'))
    assert.equal(agentConfigState(f.directory).hasJwks, true)
    assert.equal(checkAgentPackage(f.directory).configured, true)
    assert.equal(readFileSync(path.join(f.directory, 'config/agent.env'), 'utf8').includes('AITEAM_AGENT_JWKS_PATH'), false)
  } finally {
    rmSync(f.directory, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})
