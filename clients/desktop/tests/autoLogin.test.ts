import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_LOGIN_STORAGE_KEY,
  endLaunchAutoLogin,
  readAutoLoginPreference,
  resetLaunchAutoLoginForTest,
  shouldAutoLogin,
  writeAutoLoginPreference,
} from '../src/lib/autoLogin.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

const ready = { enabled: true, hasSavedCredentials: true, passwordResetPending: false }

test('auto login runs once per launch after the saved session could not be restored', () => {
  resetLaunchAutoLoginForTest()
  assert.equal(shouldAutoLogin(ready), true)
  // A later visit to the login page in the same launch (e.g. a failed attempt, then retry) is manual.
  assert.equal(shouldAutoLogin(ready), false)
})

test('any logout during the launch ends auto login, so expiry and revocation stay enforced', () => {
  resetLaunchAutoLoginForTest()
  endLaunchAutoLogin()
  assert.equal(shouldAutoLogin(ready), false)
})

test('requires the opt-in, remembered credentials and no pending password reset', () => {
  for (const input of [
    { ...ready, enabled: false },
    { ...ready, hasSavedCredentials: false },
    { ...ready, passwordResetPending: true },
  ]) {
    resetLaunchAutoLoginForTest()
    assert.equal(shouldAutoLogin(input), false)
  }
})

test('ineligible checks do not use up the launch attempt', () => {
  resetLaunchAutoLoginForTest()
  assert.equal(shouldAutoLogin({ ...ready, hasSavedCredentials: false }), false)
  assert.equal(shouldAutoLogin(ready), true)
})

test('stores only the switch, defaulting to off', () => {
  const storage = memoryStorage()
  assert.equal(readAutoLoginPreference(storage), false)
  writeAutoLoginPreference(true, storage)
  assert.deepEqual([...storage.values], [[AUTO_LOGIN_STORAGE_KEY, 'true']])
  assert.equal(readAutoLoginPreference(storage), true)
  writeAutoLoginPreference(false, storage)
  assert.equal(storage.values.size, 0)
  assert.equal(readAutoLoginPreference(null), false)
})
