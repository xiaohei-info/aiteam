import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import type { ExpertProjection } from '../src/api/agent/types.ts'
import { findEmployeeConversationId, parseRecruitmentLinks, pickTalentChatTarget, resolveTalentEmployees, talentChatBlockedReason, TALENT_GRANT_MISSING_MESSAGE } from '../src/pages/TalentMarket/talentEmployees.ts'

function employee(id: string, extra: Partial<ExpertProjection> = {}): ExpertProjection {
  return { employee_id: id, display_name: '同名员工', tenant_id: 'tenant', version: '1', handle: id, revoked: false, synced_at: '', skills: [], tools: [], ...extra }
}

test('persistent recruitment links recover authorized talent instances after reload', () => {
  const links = parseRecruitmentLinks({ data: [
    { status: 'succeeded', template_id: 'template', created_employee_id: 'one' },
    { status: 'succeeded', template_id: 'template', created_employee_id: 'two' },
    { status: 'failed', template_id: 'template', created_employee_id: 'failed' },
    { status: 'succeeded', template_id: 'different', created_employee_id: 'other' },
  ] })
  const experts = ['one', 'two', 'failed', 'other'].map(id => employee(id))
  assert.deepEqual(resolveTalentEmployees('template', experts, links).map(item => item.employee_id), ['one', 'two'])
})

test('revoked, archived, unauthorized, and merely same-name employees cannot be selected', () => {
  const experts = [employee('revoked', { revoked: true }), employee('archived', { status: 'archived' }), employee('same-name')]
  const links = ['revoked', 'archived', 'not-authorized'].map(employeeId => ({ employeeId, templateId: 'template' }))
  assert.deepEqual(resolveTalentEmployees('template', experts, links), [])
  assert.deepEqual(resolveTalentEmployees('template', [employee('canonical', { source_template_id: 'template' })], []).map(item => item.employee_id), ['canonical'])
  assert.throws(() => parseRecruitmentLinks({ bad: [] }), /格式/)
})

test('null or missing source template never infers ownership; recruitment links remain the fallback', () => {
  const experts = [
    employee('null-source', { source_template_id: null, source_template_version: null }),
    employee('missing-source'),
    employee('other-source', { source_template_id: 'different' }),
    employee('linked', { source_template_id: null }),
  ]
  assert.deepEqual(resolveTalentEmployees('template', experts, []), [])
  assert.deepEqual(resolveTalentEmployees('template', experts, [{ templateId: 'template', employeeId: 'linked' }]).map(item => item.employee_id), ['linked'])
})

test('talent workspace gates conversation by readiness and binds the recruited employee without an instance picker', () => {
  const source = readFileSync(new URL('../src/pages/TalentMarket/TalentEmployeeWorkspace.tsx', import.meta.url), 'utf8')
  const chat = readFileSync(new URL('../src/pages/TalentMarket/talentEmployeeChat.ts', import.meta.url), 'utf8')
  assert.match(source, /busyRef\.current/)
  assert.doesNotMatch(source, /<select|选择员工实例/)
  assert.match(chat, /getExpertReadiness\(employee\.employee_id\)/)
  assert.match(chat, /if \(!readiness\.available\) throw/)
  assert.match(chat, /createConversation\(\{ entry_employee_id: employee\.employee_id \}\)/)
  assert.match(source, /updateEmployeeKnowledgeBases\(employee\.employee_id, \[base\.id\]\)/)
  assert.doesNotMatch(source + chat, /entry_employee_id: templateId/)
})

test('talent start-chat goes straight to the recruited employee and reports a missing grant', () => {
  assert.deepEqual(pickTalentChatTarget([]), { kind: 'none' })
  const first = pickTalentChatTarget([employee('one'), employee('two')])
  assert.equal(first.kind === 'single' && first.employee.employee_id, 'one')
  const single = pickTalentChatTarget([employee('one')])
  assert.equal(single.kind === 'single' && single.employee.employee_id, 'one')
  const page = readFileSync(new URL('../src/pages/TalentMarket/index.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /const handleStartChat = handleOpenDetail/)
  assert.match(page, /pickTalentChatTarget\(await loadTalentEmployees\(agent\.template_id\)\)/)
  assert.match(page, /target\.kind === 'none'\) throw/)
})

test('talent start-chat reuses an employee\'s real conversation and ignores placeholders', () => {
  const conversations = [
    { id: 'emp_one', _employeeId: 'one' },
    { id: 'conv-two', _employeeId: 'two' },
    { id: 'conv-one', _employeeId: 'one' },
  ]
  assert.equal(findEmployeeConversationId(conversations, 'one'), 'conv-one')
  assert.equal(findEmployeeConversationId(conversations.slice(0, 2), 'one'), null)
  assert.equal(findEmployeeConversationId(conversations, 'missing'), null)
})

test('talent list shows why a recruited employee cannot start a conversation', () => {
  assert.equal(talentChatBlockedReason([]), TALENT_GRANT_MISSING_MESSAGE)
  assert.equal(talentChatBlockedReason([employee('active', { status: 'active' })]), null)
  assert.match(talentChatBlockedReason([employee('paused', { status: 'paused' })]) ?? '', /已暂停/)
  assert.match(talentChatBlockedReason([employee('dep', { availability_reason: 'employee_dependency_unavailable' })]) ?? '', /模型暂不可用/)
  const page = readFileSync(new URL('../src/pages/TalentMarket/index.tsx', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../src/pages/TalentMarket/AgentCard.tsx', import.meta.url), 'utf8')
  assert.match(page, /retryGrantsSync\(\)/)
  assert.match(page, /className="tm-list-header"/)
  assert.match(card, /disabled=\{recruitDisabled\}/)
  assert.match(card, /const recruitDisabled = recruiting \|\| chatBlocked/)
})
