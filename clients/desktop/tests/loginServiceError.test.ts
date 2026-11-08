import assert from 'node:assert/strict'
import test from 'node:test'
import { clockFixPlatform, loginUnavailableMessage } from '../src/lib/loginServiceError.ts'

test('503 from a token that fails local verification is not reported as Manager being down', () => {
  const message = loginUnavailableMessage('Manager token failed local verification')
  assert.match(message, /本机校验/)
  assert.doesNotMatch(message, /Manager 未就绪/)
})

test('other 503 details keep the Manager unavailable message', () => {
  for (const detail of [undefined, '', 'Manager authentication is unavailable', 'Manager tenant resolution is unavailable']) {
    assert.match(loginUnavailableMessage(detail), /Manager 未就绪/)
  }
})

test('clock_skew_detected tells the user to fix the system clock and shows the gap', () => {
  const message = loginUnavailableMessage('Local system clock differs from Manager', 'clock_skew_detected', { skew_seconds: -754 })
  assert.match(message, /系统时间/)
  assert.match(message, /约 13 分钟/)
  assert.doesNotMatch(message, /Manager 未就绪/)
  assert.match(loginUnavailableMessage('', 'clock_skew_detected', undefined, 'other'), /偏差无法确定/)
  assert.match(loginUnavailableMessage('', 'clock_skew_detected', undefined, 'other'), /自动校时/)
})

test('clock_skew_detected points to the exact clock setting on each desktop platform', () => {
  const windows = loginUnavailableMessage('', 'clock_skew_detected', { skew_seconds: 600 }, 'windows')
  assert.match(windows, /约 10 分钟/)
  assert.match(windows, /设置 > 时间和语言 > 日期和时间/)
  assert.match(windows, /立即同步/)
  assert.match(loginUnavailableMessage('', 'clock_skew_detected', undefined, 'macos'), /系统设置 > 通用 > 日期与时间/)
})

test('desktop platform is read from the WebView user agent', () => {
  assert.equal(clockFixPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'windows')
  assert.equal(clockFixPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'), 'macos')
  assert.equal(clockFixPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'other')
  assert.equal(clockFixPlatform(''), 'other')
})
