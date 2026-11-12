import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usesWindowsWindowControls } from '../src/lib/windowChrome.ts'

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

test('Windows 用自绘的 ─ ▢ ✕ 窗口控件', () => {
  assert.equal(usesWindowsWindowControls(WINDOWS_UA), true)
})

test('macOS 与 Linux 保持 macOS 式窗口外观', () => {
  assert.equal(usesWindowsWindowControls(MAC_UA), false)
  assert.equal(usesWindowsWindowControls(LINUX_UA), false)
})
