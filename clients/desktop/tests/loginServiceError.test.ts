import assert from 'node:assert/strict'
import test from 'node:test'
import { loginUnavailableMessage } from '../src/lib/loginServiceError.ts'

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
  assert.match(loginUnavailableMessage('', 'clock_skew_detected'), /偏差无法确定/)
  assert.match(loginUnavailableMessage('', 'clock_skew_detected'), /自动校时/)
})
