import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const rootPath = root.pathname

const removedLegacyFiles = [
  'src/api/client.ts',
  'src/api/manager/index.ts',
  'src/api/manager/client.ts',
  'src/api/manager/config.ts',
  'src/api/manager/types.ts',
  'src/api/manager/employeeConfig.ts',
  'src/pages/SkillCenter/api.ts',
  'src/api/hermes.ts',
  'src/api/stt.ts',
  'src/hooks/useSocket.ts',
  'src/components/Chat/CreateAgentDialog.tsx',
  'src/pages/AutoTasks/TaskCreate.tsx',
  'src/pages/AutoTasks/TaskDetail.tsx',
  'src/lib/db.ts',
  'src-tauri/src/db/commands.rs',
  'src-tauri/src/db/mod.rs',
  'src-tauri/src/db/models.rs',
  'src-tauri/src/db/schema.rs',
  'src/pages/OfficeStatus/AgentDesk.tsx',
  'src/pages/OfficeStatus/DeskUnit.tsx',
  'src/pages/OfficeStatus/OfficeFloor.tsx',
  'src/pages/OfficeStatus/PixelChar.tsx',
  'src/lib/hermesSync.ts',
  'src/lib/session.ts',
  'src/lib/messageReceiver.ts',
  'src/lib/socket.ts',
  'src/stores/auth.ts',
]

const removedSidecarBuildFiles = [
  'scripts/build-mac-intel-backend.sh',
  'scripts/check-mac-intel-backend.mjs',
  'src-tauri/tauri.intel.conf.json',
]

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

test('removed Hermes and WebSocket modules cannot return to the runtime graph', () => {
  for (const path of removedLegacyFiles) {
    assert.equal(existsSync(join(rootPath, path)), false, `${path} must stay deleted`)
  }

  const runtimeSource = sourceFiles(join(rootPath, 'src'))
    .map((path) => `// ${relative(rootPath, path)}\n${readFileSync(path, 'utf8')}`)
    .join('\n')

  assert.doesNotMatch(runtimeSource, /(?:from|import\()\s*['"][^'"]*(?:api\/hermes|api\/stt|api\/client|hooks\/useSocket|messageReceiver|lib\/socket)['"]/)
  assert.doesNotMatch(runtimeSource, /new\s+WebSocket\s*\(/)
  assert.doesNotMatch(runtimeSource, /['"`]\/api\/team(?:\/|['"`])/)
})

test('active message helpers are retained while the legacy Tauri SQLite stack stays deleted', () => {
  const senderSource = readFileSync(join(rootPath, 'src/lib/messageSender.ts'), 'utf8')
  const chatSource = readFileSync(join(rootPath, 'src/stores/chat.ts'), 'utf8')
  const mappingSource = readFileSync(join(rootPath, 'src/lib/employeeConversationMap.ts'), 'utf8')

  assert.match(senderSource, /from '\.\/message'/)
  assert.match(senderSource, /export function sendTextMessage/)
  assert.match(senderSource, /export async function blobToBase64/)
  assert.doesNotMatch(senderSource, /dbReady|persistToDb|uploadFiles|sendFileMessage|sendImageMessage|sendCardMessage/)
  assert.match(chatSource, /from '\.\.\/lib\/employeeConversationMap'/)
  assert.doesNotMatch(mappingSource, /\/api\/team|WebSocket|from ['"]\.\/db['"]/)

  const rustEntry = readFileSync(join(rootPath, 'src-tauri/src/lib.rs'), 'utf8')
  const cargoManifest = readFileSync(join(rootPath, 'src-tauri/Cargo.toml'), 'utf8')
  assert.doesNotMatch(rustEntry, /mod db|db::commands|rusqlite::Connection/)
  assert.doesNotMatch(cargoManifest, /^rusqlite\s*=/m)

  const businessSource = sourceFiles(join(rootPath, 'src'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
  assert.doesNotMatch(businessSource, /(?:from|import\()\s*['"][^'"]*lib\/db['"]/)
})

test('the Tauri bridge has no legacy Hermes cookie or generic JSON transport', () => {
  const rustEntry = readFileSync(join(rootPath, 'src-tauri/src/lib.rs'), 'utf8')
  const cargoManifest = readFileSync(join(rootPath, 'src-tauri/Cargo.toml'), 'utf8')

  assert.doesNotMatch(rustEntry, /get_cookies|set_cookie|cookie_provider|reqwest::cookie/)
  assert.doesNotMatch(rustEntry, /async fn http_request\s*\(/)
  assert.doesNotMatch(cargoManifest, /reqwest\s*=.*features\s*=\s*\[[^\]]*"cookies"/)
  assert.doesNotMatch(rustEntry, /http_request_binary|HttpState|reqwest/)
  assert.doesNotMatch(rustEntry, /headers:\s*HashMap/)
})

test('Intel builds stay available without reviving the Hermes sidecar bundle', () => {
  for (const path of removedSidecarBuildFiles) {
    assert.equal(existsSync(join(rootPath, path)), false, `${path} must stay deleted`)
  }

  const packageJson = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  assert.equal(
    packageJson.scripts?.['tauri:build:mac:intel'],
    'tauri build --target x86_64-apple-darwin --bundles dmg',
  )
  assert.equal(packageJson.scripts?.['backend:build:mac:intel'], undefined)

  const readme = readFileSync(join(rootPath, 'README.md'), 'utf8')
  assert.doesNotMatch(readme, /AIFredBackend|backend:build:mac:intel|runtime\/hermes/)
})

test('historical Hermes documentation points readers to the Agent contract', () => {
  for (const path of ['docs/archive/api-hermes.md', 'docs/archive/AI-MSG-SEND-FIX.md']) {
    const source = readFileSync(join(rootPath, path), 'utf8')
    assert.match(source, /已废弃/)
    assert.match(source, /api-agent-migration\.md/)
  }

  const openApi = JSON.parse(readFileSync(join(rootPath, 'docs/api.json'), 'utf8')) as {
    paths: Record<string, unknown>
  }
  assert.ok(openApi.paths['/api/agent/conversations/{conversation_id}/events'])
  assert.ok(Object.keys(openApi.paths).every(path => /^\/(?:api\/(?:agent|auth)\/|healthz$|readyz$|metrics$|openapi\.json$|redoc(?:\/|$))/.test(path)))
})
