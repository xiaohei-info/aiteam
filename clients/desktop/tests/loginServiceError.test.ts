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
