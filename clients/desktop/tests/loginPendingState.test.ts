import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Router navigation runs as a transition (v7_startTransition), so the login page stays visible
// while the workspace route loads. Anything the page resets after a successful login shows up
// there as a login form that looks signed-out again.
const source = readFileSync(new URL('../src/pages/Login/index.tsx', import.meta.url), 'utf8')
const runLogin = source.slice(source.indexOf('async function runLogin'), source.indexOf('const handleCancelPasswordReset'))
const success = runLogin.slice(runLogin.indexOf('writeAutoLoginPreference('), runLogin.indexOf("navigate('/chat')"))
const failure = runLogin.slice(runLogin.indexOf('} catch (err) {'))

test('router navigation is a transition, which is why the login page outlives a successful login', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  assert.match(main, /v7_startTransition:\s*true/)
})

test('a successful login keeps the submitted form and the busy button until the page is replaced', () => {
  assert.ok(success.length > 0 && failure.length > 0, 'runLogin structure changed; update this test')
  assert.doesNotMatch(success, /setIsLoading\(false\)|setPassword\(''\)|setNewPassword\(''\)|setConfirmPassword\(''\)/)
  assert.doesNotMatch(runLogin, /finally\s*{/)
})

test('a failed login or a required password change gives the form back', () => {
  assert.match(failure, /^\} catch \(err\) \{\s*setIsLoading\(false\)/)
  const resetRequired = runLogin.slice(runLogin.indexOf("outcome === 'password_reset_required'"), runLogin.indexOf('return\n'))
  assert.match(resetRequired, /setIsLoading\(false\)/)
})

test('清空企业名不会被已保存记录填回去（只有账号变化才回填）', () => {
  const sync = source.slice(source.indexOf('const syncSavedPasswordForIdentity'), source.indexOf('const handleSelectSavedProfile'))
  assert.match(sync, /fillEnterprise/)
  assert.match(sync, /if \(fillEnterprise && !nextEnterprise\.trim\(\) && saved\.enterprise\)/)
  // 企业名输入框的 onChange 明确传 false
  const enterpriseChange = source.slice(source.indexOf('name="enterprise"'), source.indexOf('name="account"') ?? source.indexOf('autoComplete="username"'))
  assert.match(enterpriseChange, /syncSavedPasswordForIdentity\(nextEnterprise, account, false\)/)
  // 账号输入框的 onChange 传 true
  assert.match(source, /syncSavedPasswordForIdentity\(enterprise, nextAccount, true\)/)
})
