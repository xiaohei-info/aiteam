import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelMcpLogin, deleteCapabilityAutoInstall, deleteLocalCapability, deleteMcpCredential, getApprovalMcpLogin, getMcpLogin, importCustomSkill, installMcpServer, listCapabilityAutoInstall, listLocalCapabilities, probeMcpServer, reopenMcpLogin, startMcpLogin, updateMcpToken } from '../src/api/agent/capabilities.ts'
import { isDocumentedRequest } from '../src/api/agent/contract.ts'
import { approvals } from '../src/api/agent/approvals.ts'
import { autoInstallKindLabel, capabilitySourceLabel, customSkillIntegrityLabel, isAutoInstalled } from '../src/pages/Capabilities/capabilityLabels.ts'

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

test('approval decision carries session_allow only when asked', async () => {
  const bodies: unknown[] = []
  const api = approvals({ request: async (o: { body?: unknown }) => { bodies.push(o.body); return { data: {} } } } as never)
  // 第 8 位仍是 remember（保持既有调用方语义），sessionAllow 在末尾。
  await api.decideApproval('c1', 'a1', 'approve', 'k1', undefined, undefined, undefined, true, undefined, true)
  assert.deepEqual(bodies, [{ decision: 'approve', remember: true, session_allow: true }])
  // 拒绝时是否写授权由 store 保证（useApprovalStore.decide 只在 approve 传这两个字段）。
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

test('自定义技能导入走文档化端点，preview 与安装用同一地址', async () => {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const client = { request: async (o: { method: string; path: string; body?: unknown }) => { calls.push(o); return { preview: null, scan: null, capability: null } } }
  await importCustomSkill(client as never, { source: 'text', skill_md: '---\nname: x\ndescription: y\n---\n', preview: true })
  await importCustomSkill(client as never, { source: 'url', url: 'https://github.com/a/b', replace: true })
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
    'POST /api/agent/capabilities/skills/custom',
    'POST /api/agent/capabilities/skills/custom',
  ])
  assert.deepEqual(calls[0]!.body, { source: 'text', skill_md: '---\nname: x\ndescription: y\n---\n', preview: true })
  assert.deepEqual(calls[1]!.body, { source: 'url', url: 'https://github.com/a/b', replace: true })
})

test('自定义技能来源与文件完整性有对应文案', () => {
  assert.equal(capabilitySourceLabel({ kind: 'skill', source: 'user_import' }), '自定义')
  assert.deepEqual(customSkillIntegrityLabel({ source: 'user_import', integrity: 'ok' }), { text: '文件未改动', attention: false })
  assert.deepEqual(customSkillIntegrityLabel({ source: 'user_import', integrity: 'modified' }), { text: '文件被改动，已停用', attention: true })
  assert.equal(customSkillIntegrityLabel({ source: 'enterprise_catalog' }), null)
  assert.equal(customSkillIntegrityLabel({ source: 'user_import' }), null)
})

test('file:// 地址还原成绝对路径（Tauri 文件选择会返回 URL）', async () => {
  const { toLocalPath } = await import('../src/lib/localSkillPath.ts')
  assert.equal(toLocalPath('file:///Users/edy/skills/x'), '/Users/edy/skills/x')
  assert.equal(toLocalPath('file://localhost/Users/edy/skills/x'), '/Users/edy/skills/x')
  assert.equal(toLocalPath('/Users/edy/skills/x'), '/Users/edy/skills/x')
  assert.equal(toLocalPath('file:///C:/Users/edy/skills/x'), 'C:/Users/edy/skills/x')
  assert.equal(toLocalPath('file:///Users/edy/%E6%96%87%E6%A1%A3'), '/Users/edy/文档')
})

test('一个包里多个技能：检查返回清单，安装带 roots', async () => {
  const calls: { body?: Record<string, unknown> }[] = []
  const client = { request: async (o: { body?: Record<string, unknown> }) => {
    calls.push(o)
    return calls.length === 1
      ? { preview: null, scan: [{ root: '01-weekly-report', name: 'weekly-report', description: '周报', file_count: 1, total_bytes: 760, ok: true }, { root: '04-bad-name', name: '', description: '', file_count: 1, total_bytes: 100, ok: false, reason: 'name 不合规' }], capability: null }
      : { preview: null, scan: null, capability: null }
  } }
  const first = await importCustomSkill(client as never, { source: 'zip', path: '/tmp/a.zip', preview: true })
  assert.equal(first?.scan?.length, 2)
  assert.equal(first?.scan?.[1]?.ok, false)
  await importCustomSkill(client as never, { source: 'zip', path: '/tmp/a.zip', roots: ['01-weekly-report'] })
  assert.deepEqual(calls[1]!.body, { source: 'zip', path: '/tmp/a.zip', roots: ['01-weekly-report'] })
})
