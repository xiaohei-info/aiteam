import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyRequestError, resolveRequestDataState } from '../src/lib/requestError.ts'

test('403 is classified as a permission error rather than empty data', () => {
  const result = classifyRequestError({ status: 403, message: 'forbidden' })

  assert.equal(result.kind, 'forbidden')
  assert.equal(result.status, 403)
  assert.match(result.title, /权限/)
})

test('410 and 503 are classified as unavailable services', () => {
  for (const status of [410, 503]) {
    const result = classifyRequestError({ status })
    assert.equal(result.kind, 'unavailable')
    assert.equal(result.status, status)
    assert.match(result.title, /不可用/)
  }
})

test('transport failures are classified as network errors', () => {
  for (const error of [
    new TypeError('Failed to fetch'),
    { code: 'ERR_NETWORK', message: 'request failed' },
    { status: 0, message: 'connection refused' },
  ]) {
    assert.equal(classifyRequestError(error).kind, 'network')
  }
})

test('status 0 client policy errors are not mislabeled as network failures', () => {
  for (const code of ['client_insecure_api_url', 'client_path_denied', 'client_bad_content_type']) {
    const result = classifyRequestError({
      status: 0,
      code,
      message: 'http://user:password@example.com/private',
    })

    assert.equal(result.kind, 'unknown')
    assert.match(result.title, /配置/)
    assert.doesNotMatch(result.message, /example\.com|password/)
  }
})

test('unexpected failures keep a supplied safe fallback message', () => {
  const result = classifyRequestError(new Error('internal detail'), '组织架构加载失败，请重试。')

  assert.equal(result.kind, 'unknown')
  assert.equal(result.message, '组织架构加载失败，请重试。')
})

test('request state never treats loading or failure as a real empty result', () => {
  const failure = classifyRequestError({ status: 503 })

  assert.equal(resolveRequestDataState(true, null, 0), 'loading')
  assert.equal(resolveRequestDataState(false, failure, 0), 'error')
  assert.equal(resolveRequestDataState(false, null, 0), 'empty')
  assert.equal(resolveRequestDataState(false, null, 2), 'ready')
})
