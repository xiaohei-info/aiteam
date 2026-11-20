import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The installer-side Git Bash setup has no runtime coverage on the Linux CI runner: the PowerShell
// script only runs inside the NSIS installer on Windows. These checks keep the parts that broke
// before (BOM, download bounds, version marker, hook wiring) visible in normal `pnpm test` runs.

const root = fileURLToPath(new URL('..', import.meta.url))
const script = readFileSync(path.join(root, 'src-tauri/resources/installer/fetch-gitbash.ps1'))
const text = script.toString('utf8')
const hooks = readFileSync(path.join(root, 'src-tauri/installer-hooks.nsh'), 'utf8')
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  bundle: { resources: Record<string, string>; windows: { nsis: { installerHooks: string } } }
}

test('内置 bash 脚本以 UTF-8 BOM 保存，Windows PowerShell 5.1 才不会按 ANSI 误读中文', () => {
  assert.deepEqual([...script.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

test('内置 bash 脚本带可见进度、版本标记与有界下载超时', () => {
  assert.match(text, /Show-Progress/)
  assert.match(text, /\$Version = '2\.56\.1'/u)
  assert.match(text, /\.mingit-version/u)
  // A dead primary mirror must not hold the installer for ten minutes.
  assert.match(text, /\$request\.Timeout = 20000/u)
  assert.match(text, /\$request\.ReadWriteTimeout = 60000/u)
  // `$input` is a PowerShell automatic variable; reusing it made the version marker unreadable.
  assert.doesNotMatch(text, /\$input\b/u)
  assert.match(text, /[0-9a-f]{64}/u, 'MinGit archive must stay pinned by SHA-256')
})

test('安装钩子调用脚本，重装时保留 gitbash，真正卸载才删除', () => {
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL/u)
  assert.match(hooks, /fetch-gitbash\.ps1/u)
  assert.match(hooks, /!macro NSIS_HOOK_PREUNINSTALL/u)
  assert.ok(hooks.includes('"_?="'), 'reinstall is detected through the in-place uninstaller flag')
  assert.ok(hooks.includes('RMDir /r "$INSTDIR\\gitbash"'))
  // The uninstaller section may only call `un.`-prefixed functions.
  assert.match(hooks, /\$\{UnStrStr\}/u)
})

test('打包配置带上 installer 资源与 Windows NSIS 钩子', () => {
  assert.equal(config.bundle.resources['resources/installer/'], 'installer/')
  assert.equal(config.bundle.windows.nsis.installerHooks, 'installer-hooks.nsh')
})
