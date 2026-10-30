import assert from 'node:assert/strict'
import test from 'node:test'
import { isImeKeyboardEvent } from '../src/lib/imeKeyboard.ts'

test('composition events and native composing state keep keys owned by the IME', () => {
  assert.equal(isImeKeyboardEvent({ isComposing: false, keyCode: 13 }, true), true)
  assert.equal(isImeKeyboardEvent({ isComposing: true, keyCode: 13 }, false), true)
})

test('WebKit confirmation Enter stays with IME even after compositionend', () => {
  assert.equal(isImeKeyboardEvent({ isComposing: false, keyCode: 229 }, false), true)
  // 下一次独立回车恢复正常发送，不吞掉用户确认后的下一键。
  assert.equal(isImeKeyboardEvent({ isComposing: false, keyCode: 13 }, false), false)
})

test('ordinary keys remain available for send and mention navigation', () => {
  for (const keyCode of [13, 38, 40, 8, 9]) {
    assert.equal(isImeKeyboardEvent({ keyCode }, false), false)
  }
})
