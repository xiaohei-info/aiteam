import assert from 'node:assert/strict'
import test from 'node:test'
import { deleteCapabilityAutoInstall, deleteLocalCapability, listCapabilityAutoInstall, listLocalCapabilities } from '../src/api/agent/capabilities.ts'
import { approvals } from '../src/api/agent/approvals.ts'
import { autoInstallKindLabel, capabilitySourceLabel, isAutoInstalled } from '../src/pages/Settings/personalCapabilityLabels.ts'

test('personal capabilities use the documented endpoints and encode the ref', async () => {
  const calls: { method: string; path: string }[] = []
  const client = { request: async (o: { method: string; path: string }) => { calls.push(o); return o.method === 'GET' ? null : undefined } }
  assert.deepEqual(await listLocalCapabilities(client as never), [])
  await deleteLocalCapability(client as never, 'mcp', 'a/b')
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /api/agent/capabilities', 'DELETE /api/agent/capabilities/mcp/a%2Fb'])
})

test('auto-install grants use the documented endpoints', async () => {
  const calls: string[] = []
  const client = { request: async (o: { method: string; path: string }) => { calls.push(`${o.method} ${o.path}`); return o.method === 'GET' ? null : undefined } }
  assert.deepEqual(await listCapabilityAutoInstall(client as never), [])
  await deleteCapabilityAutoInstall(client as never, 'skill')
  assert.deepEqual(calls, ['GET /api/agent/capabilities/auto-install', 'DELETE /api/agent/capabilities/auto-install/skill'])
})

test('approval decision sends remember only when requested', async () => {
  const bodies: unknown[] = []
  const api = approvals({ request: async (o: { body?: unknown }) => { bodies.push(o.body); return { data: {} } } } as never)
  await api.decideApproval('c1', 'a1', 'approve', 'k1')
  await api.decideApproval('c1', 'a1', 'approve', 'k2', 3, undefined, { action: 'replace' }, true)
  assert.deepEqual(bodies, [{ decision: 'approve' }, { decision: 'approve', expected_revision: 3, capability_resolution: { action: 'replace' }, remember: true }])
})

test('installed capabilities name their source and whether they were auto-installed', () => {
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'platform_catalog' }), '平台 MCP 目录')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'platform_catalog' }), '平台技能市场')
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'enterprise_catalog' }), '企业自建技能')
  assert.equal(capabilitySourceLabel({ kind: 'mcp', source: 'user_url' }), '手动地址')
  assert.equal(isAutoInstalled({ approved_by: 'policy:auto-install' }), true)
  assert.equal(isAutoInstalled({ approved_by: 'member-1' }), false)
  assert.match(autoInstallKindLabel('mcp'), /MCP/)
})
