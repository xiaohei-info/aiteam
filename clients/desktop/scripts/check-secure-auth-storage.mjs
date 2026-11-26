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

// 新版本不再保存 token，启动时只删除旧版本留在钥匙串里的 token（先覆写为空再删除）。
assert(!authStore.includes("'secure_session_read'"), 'agent auth must not restore a token from the keychain')
assert(authStore.includes("invoke<void>('secure_session_write', { session: '' })"), 'keychain token may only be overwritten with an empty value')
assert((authStore.match(/'secure_session_write'/g) ?? []).length === 1, 'agent auth must not write a token to the keychain')
assert(authStore.includes("'secure_session_delete'"), 'leftover keychain token must be deleted')
for (const command of ['secure_session_read', 'secure_session_write', 'secure_session_delete']) {
  assert(rustModule.includes(`fn ${command}`), `Rust must implement ${command}`)
  assert(rustEntry.includes(`secure_session::${command}`), `Tauri must register ${command}`)
}

assert(!/(console\.|println!|dbg!|log::|tracing::)/.test(rustModule), 'secure storage code must not log credential values')
console.log('[secure-auth] secure storage regression checks passed')
