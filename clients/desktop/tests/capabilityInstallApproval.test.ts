import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCapabilityInstall, renameProblem } from '../src/components/Approvals/capabilityInstall.ts'

const long = `https://mcp.example.com/${'a'.repeat(400)}`
const summary = (extra: object = {}) => `capability_install: ${JSON.stringify({ ref: 'crm', display_name: '客户 CRM', url: long, reason: '查订单', ...extra })}`

test('完整保留 URL（不截断），主机名单独拆出', () => {
  const p = parseCapabilityInstall('capability_install', summary())
  assert.ok(p)
  assert.equal(p.url, long)
  assert.equal(p.host, 'mcp.example.com')
  assert.equal(`${p.before}${p.host}${p.after}`, long)
  assert.equal(p.replaces, undefined)
})

test('覆盖已有能力时带出被替换的条目', () => {
  const p = parseCapabilityInstall('capability_install', summary({ replaces: { display_name: '旧 CRM', url: 'https://old.example.com/mcp' } }))
  assert.deepEqual(p?.replaces, { displayName: '旧 CRM', url: 'https://old.example.com/mcp', version: '' })
})

test('其他工具或坏摘要不走专门渲染', () => {
  assert.equal(parseCapabilityInstall('bash', summary()), null)
  assert.equal(parseCapabilityInstall('capability_install', 'capability_install: {oops'), null)
  assert.equal(parseCapabilityInstall('capability_install', 'capability_install: {"ref":"x"}'), null)
})

test('技能安装：没有地址，带版本；升级时带出已装版本', () => {
  const p = parseCapabilityInstall('capability_install', `capability_install: ${JSON.stringify({ kind: 'skill', ref: 'sheet', display_name: '读表', version: '2', reason: '', replaces: { display_name: '读表', version: '1' } })}`)
  assert.equal(p?.kind, 'skill')
  assert.equal(p?.url, '')
  assert.equal(p?.version, '2')
  assert.deepEqual(p?.replaces, { displayName: '读表', url: '', version: '1' })
})

test('改名安装的新标识要合法且不同于原标识', () => {
  assert.equal(renameProblem('crm-2', 'crm'), null)
  assert.match(renameProblem('', 'crm') ?? '', /请输入/)
  assert.match(renameProblem('CRM 2', 'crm') ?? '', /小写字母/)
  assert.match(renameProblem('crm', 'crm') ?? '', /不能与/)
})

test('来源为平台目录时标记 platform，弹窗才提供「以后直接安装」', () => {
  const platform = parseCapabilityInstall('capability_install', summary({ source: 'platform_catalog' }))
  assert.equal(platform?.source, 'platform_catalog')
  assert.equal(platform?.platform, true)
  assert.equal(parseCapabilityInstall('capability_install', summary({ source: 'user_url' }))?.platform, false)
  // 旧版 Agent 不带 source：不提供勾选。
  assert.equal(parseCapabilityInstall('capability_install', summary())?.platform, false)
  const skill = parseCapabilityInstall('capability_install', `capability_install: ${JSON.stringify({ kind: 'skill', ref: 's', version: '1', source: 'enterprise_catalog' })}`)
  assert.equal(skill?.platform, false)
})

test('MCP 鉴权：带出 oauth 登录主机与 bearer 请求头；旧版 Agent 没有 auth 时为 none', () => {
  const oauth = parseCapabilityInstall('capability_install', summary({ kind: 'mcp', auth: 'oauth', auth_host: 'mcp-test.cycplus.com' }))
  assert.equal(oauth?.auth, 'oauth')
  assert.equal(oauth?.authHost, 'mcp-test.cycplus.com')
  const bearer = parseCapabilityInstall('capability_install', summary({ auth: 'bearer', auth_header: 'X-API-Key' }))
  assert.equal(bearer?.auth, 'bearer')
  assert.equal(bearer?.authHeader, 'X-API-Key')
  assert.equal(parseCapabilityInstall('capability_install', summary())?.auth, 'none')
  assert.equal(parseCapabilityInstall('capability_install', summary({ auth: 'weird' }))?.auth, 'none')
  const skill = parseCapabilityInstall('capability_install', `capability_install: ${JSON.stringify({ kind: 'skill', ref: 's', display_name: 'S', version: '1', auth: 'oauth' })}`)
  assert.equal(skill?.auth, 'none', '技能没有鉴权')
})
