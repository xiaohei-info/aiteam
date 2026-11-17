import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteLocalCapability, listLocalCapabilities } from '../src/api/agent/capabilities.ts'

test('personal capabilities use the documented endpoints and encode the ref', async () => {
  const calls: { method: string; path: string }[] = []
  const client = { request: async (o: { method: string; path: string }) => { calls.push(o); return o.method === 'GET' ? null : undefined } }
  assert.deepEqual(await listLocalCapabilities(client as never), [])
  await deleteLocalCapability(client as never, 'mcp', 'a/b')
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /api/agent/capabilities', 'DELETE /api/agent/capabilities/mcp/a%2Fb'])
})
