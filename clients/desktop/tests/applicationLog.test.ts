import assert from 'node:assert/strict'
import test from 'node:test'
import { applicationLogSnapshot, clearApplicationLogMemory, installLogSink, newRequestCorrelation, recordApplicationLog, safeLogRoute } from '../src/lib/applicationLog.ts'
import { logDevRequest } from '../src/api/requestLogging.ts'

test('application logs retain only metadata and do not leak payloads in any environment', () => {
  clearApplicationLogMemory()
  const correlation = newRequestCorrelation()
  const finish = logDevRequest('AgentApi', { method: 'POST', url: 'https://user:secret@agent.test/api/agent/conversations/private-title/prompt?password=secret', hasBody: true, requestId: correlation.request_id, traceId: correlation.trace_id, body: { password: 'sentinel', content: 'private chat' } })
  finish(500, { data: { content: 'private chat', token: 'sentinel' } })
  finish(500)
  const snapshot = applicationLogSnapshot()
  assert.equal(snapshot.records.length, 2)
  assert.equal(snapshot.records[1].fields.request_id, correlation.request_id)
  assert.equal(snapshot.records[1].fields.status, 500)
  assert.doesNotMatch(JSON.stringify(snapshot), /private-title|private chat|sentinel|secret|password|user:/)
  assert.equal(safeLogRoute('/api/agent/messages/search?q=secret'), '/api/agent/messages/search')
})

test('buffer overflow and sink errors are counted, caller mutations cannot change stored logs', () => {
  clearApplicationLogMemory()
  const cleanup = installLogSink(() => { throw new Error('secret disk error') })
  for (let i = 0; i < 1010; i++) recordApplicationLog('info', 'test.event', { count: i, stack: 'secret' })
  const snapshot = applicationLogSnapshot()
  assert.equal(snapshot.records.length, 1000)
  assert.equal(snapshot.dropped, 10)
  assert.equal(snapshot.sink_failures, 1010)
  snapshot.records[0].event = 'tampered'
  assert.equal(applicationLogSnapshot().records[0].event, 'test.event')
  cleanup()
})

test('request trace and cancellation are safe and present', () => {
  clearApplicationLogMemory()
  const c = newRequestCorrelation()
  assert.match(c.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  logDevRequest('AgentApi', { method: 'GET', url: '/api/agent/conversations', hasBody: false, requestId: c.request_id })('cancelled')
  const last = applicationLogSnapshot().records.at(-1)!
  assert.equal(last.level, 'warn')
  assert.equal(last.fields.outcome, 'cancelled')
})
