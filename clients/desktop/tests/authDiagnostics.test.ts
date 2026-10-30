import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTH_DIAGNOSTIC_KEY, recordAuthDiagnostic, readAuthDiagnostics, authErrorStatus, type AuthDiagnosticInput } from '../src/lib/authDiagnostics.ts'

test('退出诊断仅存白名单字段，限 100 条并支持重读', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  } })
  try {
    for (let i = 0; i < 110; i++) recordAuthDiagnostic({
      reason: 'token_expired', source: 'expiry_timer', expiresInSeconds: i,
      token: 'secret-token', account: 'private@example.com', message: 'Bearer secret',
    } as AuthDiagnosticInput)
    const result = readAuthDiagnostics()
    assert.equal(result.length, 100)
    assert.equal(result[0].expiresInSeconds, 10)
    assert.doesNotMatch(store.get(AUTH_DIAGNOSTIC_KEY)!, /secret|private@example|Bearer/)
    store.set(AUTH_DIAGNOSTIC_KEY, JSON.stringify([{ ...result[0], token: 'another-secret', status: 'private-error', verification: 'secret-result' }]))
    assert.doesNotMatch(JSON.stringify(readAuthDiagnostics()), /secret|private-error/)
    store.set(AUTH_DIAGNOSTIC_KEY, JSON.stringify([{ ...result[0], reason: 'private-text' }]))
    assert.deepEqual(readAuthDiagnostics(), [])
    store.set(AUTH_DIAGNOSTIC_KEY, 'not-json')
    assert.doesNotThrow(() => recordAuthDiagnostic({ reason: 'restore_vault_failed', source: 'restore' }))
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('错误日志仅提取状态码，不保存错误详情；凭证库不可用不阻断流程', () => {
  assert.equal(authErrorStatus({ status: 401, message: 'secret' }), 401)
  assert.equal(authErrorStatus({ cause: { status: 503 } }), 503)
  assert.equal(authErrorStatus({ status: 'secret' }), undefined)
  assert.doesNotThrow(() => recordAuthDiagnostic({ reason: 'restore_missing', source: 'restore' }))
})
