import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_URL_SECURITY_ERROR_CODE,
  ApiUrlSecurityError,
  assertSecureApiUrl,
  assertSecureDownloadUrl,
  isLoopbackHostname,
} from '../src/api/urlSecurity.ts'
import { TEST_AGENT_BASE_URL, DEPLOYED_AGENT_HTTP_ORIGINS } from '../src/api/agent/config.ts'

test('API URL policy allows HTTPS, relative paths, and loopback HTTP', () => {
  const allowed = [
    'https://aifred.cn/api/agent/login',
    '/api/agent/conversations/1/events',
    'http://localhost:8000/healthz',
    'http://agent.localhost:8000/upload',
    'http://127.12.34.56:8000/download',
    'http://[::1]:8000/readyz',
  ]

  for (const url of allowed) assert.equal(assertSecureApiUrl(url), url)
  assert.equal(isLoopbackHostname('localhost.evil.example'), false)
})

test('API URL policy rejects remote plaintext HTTP with a clear error', () => {
  assert.throws(
    () => assertSecureApiUrl('http://121.40.78.201:8783/api/agent/login', '登录'),
    (err: unknown) => {
      assert.ok(err instanceof ApiUrlSecurityError)
      assert.equal(err.code, API_URL_SECURITY_ERROR_CODE)
      assert.match(err.message, /必须使用 HTTPS/)
      assert.match(err.message, /http:\/\/121\.40\.78\.201:8783/)
      assert.doesNotMatch(err.message, /password/)
      return true
    },
  )
})

test('API URL policy allows only the pinned plaintext Agent deployment when explicitly requested', () => {
  assert.equal(TEST_AGENT_BASE_URL, 'http://121.40.78.201:8783')
  const deployedUrl = 'http://121.40.78.201:8783/healthz'
  assert.equal(
    assertSecureApiUrl(deployedUrl, 'Agent API', DEPLOYED_AGENT_HTTP_ORIGINS),
    deployedUrl,
  )

  for (const url of [
    'http://121.40.78.201/healthz',
    'http://121.40.78.201:8782/healthz',
    'http://user:secret@121.40.78.201:8783/healthz',
    'http://121.40.78.202:8783/healthz',
  ]) {
    assert.throws(
      () => assertSecureApiUrl(url, 'Agent API', DEPLOYED_AGENT_HTTP_ORIGINS),
      ApiUrlSecurityError,
    )
  }
})

test('download policy keeps local resource schemes but rejects remote HTTP', () => {
  for (const url of ['asset://localhost/tmp/report.pdf', 'blob:https://aifred.cn/id', 'data:text/plain,ok']) {
    assert.equal(assertSecureDownloadUrl(url), url)
  }
  assert.throws(
    () => assertSecureDownloadUrl('http://files.example.com/report.pdf'),
    ApiUrlSecurityError,
  )
  assert.throws(
    () => assertSecureDownloadUrl('blob:http://files.example.com/report-id'),
    ApiUrlSecurityError,
  )
})

test('API URL policy rejects empty, malformed, and unsupported absolute addresses', () => {
  for (const url of ['', '//example.com/api', 'ftp://example.com/file']) {
    assert.throws(() => assertSecureApiUrl(url), ApiUrlSecurityError)
  }
})
