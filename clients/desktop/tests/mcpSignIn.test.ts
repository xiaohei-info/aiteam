import assert from 'node:assert/strict'
import test from 'node:test'
import { addMcpProblem, addMcpRequest, signInFailureText, type AddMcpForm } from '../src/lib/mcpSignIn.ts'
import { mcpAuthStatusLabel } from '../src/pages/Capabilities/capabilityLabels.ts'

const form = (patch: Partial<AddMcpForm> = {}): AddMcpForm => ({
  ref: 'cr-test', displayName: '', url: 'https://mcp-test.cycplus.com/mcp/cr-test', timeoutMs: 30000, reason: '',
  auth: null, token: '', header: '', clientId: '', clientSecret: '', replace: false, ...patch,
})

test('添加 MCP 表单校验：地址、标识、超时、令牌、请求头、应用密钥', () => {
  assert.equal(addMcpProblem(form()), null)
  assert.match(addMcpProblem(form({ url: '' })) ?? '', /填写 MCP 地址/)
  assert.match(addMcpProblem(form({ url: 'ftp://x' })) ?? '', /https/)
  assert.match(addMcpProblem(form({ url: 'not a url' })) ?? '', /格式/)
  assert.match(addMcpProblem(form({ ref: 'CR Test' })) ?? '', /小写字母/)
  assert.match(addMcpProblem(form({ timeoutMs: 999 })) ?? '', /1000–300000/)
  assert.match(addMcpProblem(form({ timeoutMs: 300001 })) ?? '', /1000–300000/)
  assert.equal(addMcpProblem(form({ timeoutMs: null })), null, '不填超时用默认值')
  assert.match(addMcpProblem(form({ auth: 'bearer' })) ?? '', /访问令牌/)
  assert.equal(addMcpProblem(form({ auth: 'bearer', token: 't' })), null)
  assert.match(addMcpProblem(form({ auth: 'bearer', token: 't', header: 'X API' })) ?? '', /请求头名/)
  assert.match(addMcpProblem(form({ clientSecret: 's' })) ?? '', /应用编号/)
})

test('请求体只带当前鉴权方式需要的字段', () => {
  assert.deepEqual(addMcpRequest(form({ displayName: ' CR ', reason: '' })), { ref: 'cr-test', url: 'https://mcp-test.cycplus.com/mcp/cr-test', display_name: 'CR', timeout_ms: 30000 })
  assert.deepEqual(addMcpRequest(form({ auth: 'bearer', token: ' tok ', header: 'X-API-Key', clientId: 'ignored' })).credential, { token: 'tok', header: 'X-API-Key' })
  assert.equal(addMcpRequest(form({ auth: 'bearer', token: 't', clientId: 'c' })).oauth_client, undefined)
  assert.deepEqual(addMcpRequest(form({ auth: 'oauth', clientId: 'c1', clientSecret: 's1', token: 'stale' })), {
    ref: 'cr-test', url: 'https://mcp-test.cycplus.com/mcp/cr-test', timeout_ms: 30000, oauth_client: { client_id: 'c1', client_secret: 's1' },
  })
  assert.equal(addMcpRequest(form({ replace: true })).replace, true)
})

test('登录失败原因带下一步建议', () => {
  assert.equal(signInFailureText('timeout'), '登录超时：10 分钟内没有完成登录。可以稍后重试。')
  assert.equal(signInFailureText('denied', 'X'), '你在服务方页面拒绝了授权。X')
  assert.equal(signInFailureText(undefined), '登录没有完成。可以稍后重试。')
})

test('个人能力的鉴权状态标签', () => {
  assert.equal(mcpAuthStatusLabel({ kind: 'skill', auth_status: 'none' }), null)
  assert.equal(mcpAuthStatusLabel({ kind: 'mcp' }), null, '旧版 Agent 不返回状态')
  assert.deepEqual(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'none' }), { text: '无需登录', attention: false })
  assert.deepEqual(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'signed_in', auth_expires_at: null }), { text: '已登录', attention: false })
  assert.match(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'signed_in', auth_expires_at: '2026-11-20T08:05:00Z' })?.text ?? '', /^已登录（到期 2026-11-2\d \d\d:05）$/)
  assert.deepEqual(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'needs_login' }), { text: '需要重新登录', attention: true })
  assert.deepEqual(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'token_set' }), { text: '已填令牌', attention: false })
  assert.deepEqual(mcpAuthStatusLabel({ kind: 'mcp', auth_status: 'needs_token' }), { text: '需要填写令牌', attention: true })
})
