import assert from 'node:assert/strict'
import test from 'node:test'
import { createAutomationTask, deleteAutomationTask, listAutomationTaskRuns, listAutomationTasks, setAutomationTaskAction, updateAutomationTask } from '../src/api/agent/automationTasks.ts'
import type { ServiceApiClient } from '../src/api/agent/client.ts'

function mockClient(handler: (options: any) => unknown) {
  return { request: async (options: any) => handler(options) } as ServiceApiClient
}

const schedule = { mode: 'daily' as const, timezone: 'Asia/Shanghai', time: '09:00:00' }
const body = { name: '日报', prompt: '生成日报', category: 'report' as const, employee_id: 'employee-1', connector_ids: [], schedule }

test('automation task API sends idempotent create and optimistic-lock headers', async () => {
  const requests: any[] = []
  const client = mockClient(options => { requests.push(options); return { task_id: 'task-1' } })
  await createAutomationTask(client, body, 'request-key')
  await updateAutomationTask(client, 'task-1', { name: '新日报' }, '"etag-1"')
  await setAutomationTaskAction(client, 'task-1', 'pause', '"etag-2"')
  await deleteAutomationTask(client, 'task-1', '"etag-3"')
  assert.equal(requests[0].path, '/api/agent/automation-tasks')
  assert.equal(requests[0].idempotencyKey, 'request-key')
  assert.equal(requests[1].headers['If-Match'], '"etag-1"')
  assert.match(requests[2].path, /actions\/pause$/)
  assert.equal(requests[3].method, 'DELETE')
})

test('automation task list and run history preserve pagination payloads', async () => {
  const requests: any[] = []
  const client = mockClient(options => { requests.push(options); return { data: [], page: { next_cursor: 'next', has_more: true } } })
  const list = await listAutomationTasks(client, { status: 'active', limit: 50 })
  const runs = await listAutomationTaskRuns(client, 'task-1', { cursor: 'cursor' })
  assert.equal(list.page.next_cursor, 'next')
  assert.equal(runs.page.has_more, true)
  assert.equal(requests[0].raw, true)
  assert.equal(requests[1].query.cursor, 'cursor')
})
