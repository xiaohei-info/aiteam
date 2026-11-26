import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { describeLoginApiFailure, tenantCandidateLabel, tenantSelectionCandidates } from '../src/lib/loginFailure.ts'

const problem = (status: number, code: string, detail = '', meta?: unknown) => ({ status, code, message: detail, problem: { code, detail, meta } })

test('401 提示账号或密码错误，改密时提示当前密码不正确', () => {
  assert.equal(describeLoginApiFailure(problem(401, 'unauthorized', 'invalid credentials'), false), '企业标识、账号或密码错误，请重试')
  assert.equal(describeLoginApiFailure(problem(401, 'unauthorized'), true), '当前密码不正确，请重新输入')
})

test('403 区分账号停用、企业不可用与权限不足', () => {
  assert.equal(describeLoginApiFailure(problem(403, 'principal_inactive', 'account is not active'), false), '账号已停用，请联系企业管理员')
  assert.equal(describeLoginApiFailure(problem(403, 'tenant_deleted', '企业已删除'), false), '企业已删除')
  assert.equal(describeLoginApiFailure(problem(403, 'forbidden', 'nope'), false), '当前账号无法完成此操作，请联系管理员')
})

test('409 不再显示为后端异常：多企业提示填写企业标识，企业重名提示改填企业代码', () => {
  const multi = describeLoginApiFailure(problem(409, 'tenant_selection_required', 'account belongs to multiple tenants'), false)
  assert.match(multi, /多个企业/)
  assert.doesNotMatch(multi, /后端服务异常|tenants/)
  assert.match(describeLoginApiFailure(problem(409, 'enterprise_ambiguous', 'ambiguous'), false), /企业代码/)
})

test('503 沿用企业服务不可用提示；其余 4xx 透传 detail；只有 5xx 才是后端异常', () => {
  assert.match(describeLoginApiFailure(problem(503, 'manager_unavailable', 'Manager authentication is unavailable'), false), /Manager 未就绪/)
  assert.equal(describeLoginApiFailure(problem(429, 'too_many_attempts', '尝试次数过多'), false), '尝试次数过多')
  assert.equal(describeLoginApiFailure(problem(500, 'internal_error'), false), '后端服务异常,请稍后重试')
})

test('410 client_upgrade_required 提示升级客户端', () => {
  assert.equal(describeLoginApiFailure(problem(410, 'client_upgrade_required', '客户端版本过旧，请升级后登录'), false), '客户端版本过旧，请升级后登录')
  assert.equal(describeLoginApiFailure(problem(410, 'client_upgrade_required'), false), '客户端版本过旧，请升级后登录')
})

test('tenant_selection_required 解析候选企业，过滤无效项，名称为空时展示企业标识', () => {
  const err = problem(409, 'tenant_selection_required', 'multi', {
    candidates: [
      { tenant_id: 't-a', enterprise_name: '甲企业' },
      { tenant_id: '', enterprise_name: '坏数据' },
      { tenant_id: 't-c', enterprise_name: '  ' },
      'junk',
    ],
  })
  const candidates = tenantSelectionCandidates(err)
  assert.deepEqual(candidates, [{ tenant_id: 't-a', enterprise_name: '甲企业' }, { tenant_id: 't-c', enterprise_name: '' }])
  assert.deepEqual(candidates.map(tenantCandidateLabel), ['甲企业', 't-c'])
  assert.deepEqual(tenantSelectionCandidates(problem(409, 'tenant_selection_required', 'multi')), [])
  assert.deepEqual(tenantSelectionCandidates(problem(409, 'enterprise_ambiguous', 'x', { candidates: [{ tenant_id: 't', enterprise_name: 'n' }] })), [])
})

test('登录页在多企业时弹出企业选择，选中后按 tenant_id 重新登录，不把名称写回企业标识', () => {
  const source = readFileSync(new URL('../src/pages/Login/index.tsx', import.meta.url), 'utf8')
  assert.match(source, /tenantSelectionCandidates\(err\)/)
  assert.match(source, /<TenantPickerDialog/)
  const pick = source.slice(source.indexOf('const handlePickTenant'), source.indexOf('const handleCancelTenantPick'))
  assert.match(pick, /runLogin\(\{ \.\.\.pending\.input, tenantId: candidate\.tenant_id \}\)/)
  assert.doesNotMatch(pick, /setEnterprise|enterprise_name/)
  const dialog = readFileSync(new URL('../src/pages/Login/TenantPickerDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /tenantCandidateLabel\(candidate\)/)
})

test('企业选择弹窗：头部 / 可滚动列表 / 底部固定三段，列表可滚动', () => {
  const css = readFileSync(new URL('../src/pages/Login/TenantPickerDialog.css', import.meta.url), 'utf8')
  assert.match(css, /\.tpd \{[^}]*max-height: calc\(100dvh - 40px\)/)
  assert.match(css, /\.tpd-list \{[^}]*min-height: 0;[^}]*overflow-y: auto/)
  assert.match(css, /\.tpd-footer \{[^}]*flex: none/)
})
