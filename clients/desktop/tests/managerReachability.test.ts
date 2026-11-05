import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MANAGER_UNAVAILABLE_NOTICE,
  isManagerUnavailable,
  reportManagerResponse,
  restoreFailureMessage,
  useManagerReachability,
} from '../src/lib/managerReachability.ts'

const unavailable = () => useManagerReachability.getState().unavailable

test('only 503 manager_unavailable marks the enterprise service unreachable', () => {
  useManagerReachability.setState({ unavailable: false })
  for (const [status, code] of [[503, 'memory_unavailable'], [503, undefined], [401, 'unauthenticated'], [500, 'manager_unavailable']] as const) {
    reportManagerResponse(status, code, true)
    assert.equal(unavailable(), false, `${status} ${code ?? ''} is not a Manager outage`)
  }
  reportManagerResponse(503, 'manager_unavailable', true)
  assert.equal(unavailable(), true)
  assert.equal(isManagerUnavailable(503, 'manager_unavailable'), true)
})

test('only an authenticated success proves Manager is reachable again', () => {
  useManagerReachability.setState({ unavailable: true })
  reportManagerResponse(200, undefined, false)
  assert.equal(unavailable(), true, 'public routes such as healthz do not consult Manager')
  reportManagerResponse(404, 'not_found', true)
  assert.equal(unavailable(), true)
  reportManagerResponse(204, undefined, true)
  assert.equal(unavailable(), false)
})

test('restore keeps the saved login and asks to retry when Manager is unreachable', () => {
  assert.match(restoreFailureMessage({ status: 503, code: 'manager_unavailable' }), /企业服务暂时连不上/)
  assert.match(restoreFailureMessage({ status: 401, code: 'unauthenticated' }), /无法验证已保存身份/)
  assert.match(restoreFailureMessage(new Error('boom')), /无法验证已保存身份/)
  assert.match(restoreFailureMessage(null), /无法验证已保存身份/)
})

test('notice copy follows the failure tone: apology first, then one step', () => {
  assert.equal(MANAGER_UNAVAILABLE_NOTICE, '抱歉，企业服务暂时连不上，请稍后再试。')
})

test('request client reports every Agent response and only 401 can trigger logout', () => {
  const source = readFileSync(new URL('../src/api/agent/client.ts', import.meta.url), 'utf8')
  assert.match(source, /if \(res\.ok\) reportManagerResponse\(res\.status, undefined, authenticated\)/)
  assert.match(source, /reportManagerResponse\(res\.status, problem\?\.code, authenticated\)/)
  assert.match(source, /return response\.status === 401\n/, 'session confirmation treats only 401 as expiry, never 503')
  const layout = readFileSync(new URL('../src/components/Layout/index.tsx', import.meta.url), 'utf8')
  assert.match(layout, /<TopBar \/>\n\s+<ManagerUnavailableNotice \/>/)
})
