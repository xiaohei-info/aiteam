import { restoreAgentNode } from './agent-runtime.mjs'
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseAgentEnv(text) {
  const values = new Map()
  for (const original of text.split(/\r?\n/u)) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2'))
  }
  return values
}

// The bundled config drives the Agent launch, and manifest.json is also the cache
// key for the copied config directory. A hand-edited config under the old manifest
// would otherwise be silently ignored on machines that already cached that
// revision, so verify the packaged config against the manifest before use.
function verifyConfigIntegrity(directory, manifest) {
  const entries = (manifest.files ?? []).filter(entry => typeof entry.path === 'string' && entry.path.startsWith('config/'))
  if (!entries.length) throw new Error('Agent manifest lists no config files')
  for (const entry of entries) {
    let bytes
    try {
      bytes = readFileSync(path.join(directory, entry.path))
    } catch {
      throw new Error(`Agent package is missing a manifest file: ${entry.path}`)
    }
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Agent package config was modified without refreshing manifest.json: ${entry.path}`)
    }
  }
}

// A template package has placeholder Manager/JWKS values. Expose that fact instead of
// letting a release ship a sidecar that the Agent always refuses to start.
export function agentConfigState(directory) {
  const values = parseAgentEnv(readFileSync(path.join(directory, 'config/agent.env'), 'utf8'))
  return {
    environment: values.get('AITEAM_ENV') ?? '',
    managerUrl: values.get('AITEAM_MANAGER_URL') ?? '',
    // manager 模式：登录时从固定的 Manager origin 按租户拉取公钥，不随包携带静态 JWKS。
    hasJwks: Boolean(values.get('AITEAM_AGENT_JWKS_JSON') || values.get('AITEAM_AGENT_JWKS_PATH') || values.get('AITEAM_AGENT_JWKS_MODE') === 'manager'),
    hasSkillKey: Boolean(values.get('AITEAM_SKILL_SIGNING_PUBLIC_KEY') || values.get('AITEAM_SKILL_SIGNING_PUBLIC_KEYS')),
  }
}

export function checkAgentPackage(directory) {
  const manifestPath = path.join(directory, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error(`Agent manifest is missing or unreadable: ${manifestPath}`)
  }
  if (manifest.schema_version !== 1 || manifest.product !== 'aiteam-agent' || manifest.target !== 'darwin-arm64') {
    throw new Error('This desktop integration requires an aiteam-agent darwin-arm64 package (manifest schema 1)')
  }
  if (manifest.capabilities?.reconciliation !== 2 || manifest.capabilities?.active_run_snapshots !== true || manifest.capabilities?.facts_state !== true) {
    throw new Error('Agent package is outdated: reconciliation v2 with active run and facts state snapshots is required. Run pnpm agent:build to rebuild it from server/agent_service.')
  }
  restoreAgentNode(directory, manifest)
  for (const file of ['runtime/node', 'bin/start-agent.mjs', 'dist/main.js', 'node_modules/tsx/dist/esm/index.mjs', 'config/agent.env']) {
    accessSync(path.join(directory, file), constants.R_OK)
  }
  accessSync(path.join(directory, 'runtime/node'), constants.X_OK)
  verifyConfigIntegrity(directory, manifest)
  const template = manifest.config_source === 'template'
  if (Boolean(manifest.configured) === template) {
    throw new Error(`Agent manifest disagrees with its config: configured=${manifest.configured}, config_source=${manifest.config_source}`)
  }
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const directory = path.join(root, 'src-tauri/resources/agent')
    const manifest = checkAgentPackage(directory)
    console.log(`Agent package ready: ${manifest.version}, ${manifest.target}, configured=${manifest.configured}`)
    if (!manifest.configured) {
      const state = agentConfigState(directory)
      console.error(`Agent package is a ${state.environment || 'production'} template (manager=${state.managerUrl || 'unset'}, jwks=${state.hasJwks}, skillKey=${state.hasSkillKey}); the Agent refuses to start without a complete enterprise config. See docs/agent-sidecar.md.`)
    }
  } catch (error) {
    console.error(`Agent package unavailable: ${error.message}\nRun pnpm agent:build first (builds it from server/agent_service), or pnpm agent:import <artifact.zip>.`)
    process.exitCode = 1
  }
}
