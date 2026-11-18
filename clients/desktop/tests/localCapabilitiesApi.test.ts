import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelMcpLogin, deleteCapabilityAutoInstall, deleteLocalCapability, deleteMcpCredential, getApprovalMcpLogin, getMcpLogin, installMcpServer, listCapabilityAutoInstall, listLocalCapabilities, probeMcpServer, reopenMcpLogin, startMcpLogin, updateMcpToken } from '../src/api/agent/capabilities.ts'
import { isDocumentedRequest } from '../src/api/agent/contract.ts'
import { approvals } from '../src/api/agent/approvals.ts'
import { autoInstallKindLabel, capabilitySourceLabel, isAutoInstalled } from '../src/pages/Capabilities/capabilityLabels.ts'

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

test('approval decision carries the MCP token only when given', async () => {
  const bodies: unknown[] = []
  const api = approvals({ request: async (o: { body?: unknown }) => { bodies.push(o.body); return { data: {} } } } as never)
  await api.decideApproval('c1', 'a1', 'approve', 'k1', undefined, undefined, undefined, false, { token: 't', header: 'X-API-Key' })
  assert.deepEqual(bodies, [{ decision: 'approve', credential: { token: 't', header: 'X-API-Key' } }])
})

test('MCP auth calls use documented endpoints, encode ids and send the token only in the body', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const reply: Record<string, unknown> = {
    'POST /api/agent/capabilities/mcp/probe': { auth: 'oauth', auth_host: 'mcp.example.com' },
    'POST /api/agent/capabilities/mcp': { capability: null, login: { login_id: 'l1' } },
    'POST /api/agent/capabilities/mcp/a%2Fb/auth': { login: null },
    'POST /api/agent/mcp-auth/logins/l%2F1/open': { opened: true },
  }
  const client = { request: async (o: { method: string; path: string; body?: unknown }) => { calls.push(o); return reply[`${o.method} ${o.path}`] ?? null } }
  assert.deepEqual(await probeMcpServer(client as never, 'https://mcp.example.com/mcp'), { auth: 'oauth', auth_host: 'mcp.example.com' })
  assert.deepEqual((await installMcpServer(client as never, { ref: 'cr', url: 'https://mcp.example.com/mcp' })).login, { login_id: 'l1' })
  assert.equal(await startMcpLogin(client as never, 'a/b'), null)
  await updateMcpToken(client as never, 'a/b', { token: 'secret-value' })
  await deleteMcpCredential(client as never, 'a/b')
  assert.equal(await getMcpLogin(client as never, 'l/1'), null)
  assert.equal(await reopenMcpLogin(client as never, 'l/1'), true)
  await cancelMcpLogin(client as never, 'l/1')
  assert.equal(await getApprovalMcpLogin(client as never, 'c/1', 'a/1'), null)
  const keys = calls.map(c => `${c.method} ${c.path}`)
  assert.deepEqual(keys, [
    'POST /api/agent/capabilities/mcp/probe',
    'POST /api/agent/capabilities/mcp',
    'POST /api/agent/capabilities/mcp/a%2Fb/auth',
    'PUT /api/agent/capabilities/mcp/a%2Fb/token',
    'DELETE /api/agent/capabilities/mcp/a%2Fb/credential',
    'GET /api/agent/mcp-auth/logins/l%2F1',
    'POST /api/agent/mcp-auth/logins/l%2F1/open',
    'POST /api/agent/mcp-auth/logins/l%2F1/cancel',
    'GET /api/agent/conversations/c%2F1/approvals/a%2F1/auth',
  ])
  for (const c of calls) assert.ok(isDocumentedRequest(c.method, c.path), `${c.method} ${c.path}`)
  assert.ok(!keys.some(k => k.includes('secret-value')), 'token never in a path')
  assert.deepEqual(calls[3]?.body, { token: 'secret-value' })
})
