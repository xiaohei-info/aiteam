import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const [authStore, rustModule, rustEntry] = await Promise.all([
  readFile(path.join(repoRoot, 'src', 'stores', 'agentAuth.ts'), 'utf8'),
  readFile(path.join(repoRoot, 'src-tauri', 'src', 'secure_session.rs'), 'utf8'),
  readFile(path.join(repoRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
])

function assert(condition, message) {
  if (!condition) throw new Error(`[secure-auth] ${message}`)
}

assert(!/localStorage\.setItem\s*\(/.test(authStore), 'agent auth must never persist a token in WebView localStorage')
assert(!/sessionStorage\.setItem\s*\(/.test(authStore), 'agent auth must never persist a token in WebView sessionStorage')
assert(!authStore.includes('@tauri-apps/plugin-store'), 'agent auth must not put a token in the WebView-backed Tauri store')
assert(/localStorage\.removeItem\s*\(LEGACY_STORAGE_KEY\)/.test(authStore), 'legacy token storage must be removed')
assert(!/console\./.test(authStore), 'agent auth must not log session or credential values')

for (const command of ['secure_session_read', 'secure_session_write', 'secure_session_delete']) {
  assert(authStore.includes(`'${command}'`), `frontend must invoke ${command}`)
  assert(rustModule.includes(`fn ${command}`), `Rust must implement ${command}`)
  assert(rustEntry.includes(`secure_session::${command}`), `Tauri must register ${command}`)
}

assert(!/(console\.|println!|dbg!|log::|tracing::)/.test(rustModule), 'secure storage code must not log credential values')
console.log('[secure-auth] secure storage regression checks passed')
