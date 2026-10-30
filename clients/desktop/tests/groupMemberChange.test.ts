import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GROUP_ORCHESTRATION_PATH,
  GROUP_PARTICIPANTS_PATH,
  NO_GROUP_EDITING,
  replaceGroupOrchestration,
  supportsGroupEditing,
  updateGroupMembers,
} from '../src/api/agent/customGroups.ts'
import type { AgentApiClient } from '../src/api/agent/client.ts'
import { mentionBindings } from '../src/lib/customGroupForm.ts'
import {
  decodeGroupPrompt,
  describeGroupEditError,
  memberEditAvailability,
  nextRoster,
  planMemberUpdate,
  planOrchestrationUpdate,
  promptReferences,
  removedReferences,
  validateMemberChange,
} from '../src/lib/groupMemberChange.ts'

const bindings = mentionBindings([
  { employeeId: 'a', displayName: '销售' },
  { employeeId: 'b', displayName: '技术' },
  { employeeId: 'c', displayName: '项目经理' },
])
const custom = (prompt: string) => ({ mode: 'custom' as const, format: 'collaboration-markdown-v1' as const, prompt })
const change = { currentIds: ['a', 'b'], coordinatorId: 'a', add: [] as string[], remove: [] as string[] }

test('roster after a change keeps current members, drops removals and appends additions', () => {
  assert.deepEqual(nextRoster({ currentIds: ['a', 'b'], add: ['c'], remove: ['b'] }), ['a', 'c'])
  assert.deepEqual(nextRoster({ currentIds: ['a', 'b'], add: ['b', 'c'], remove: [] }), ['a', 'b', 'c'])
})

test('member change is validated with the same rules the server enforces', () => {
  assert.match(validateMemberChange(change) ?? '', /请选择/)
  assert.match(validateMemberChange({ ...change, add: ['c', 'c'] }) ?? '', /重复/)
  assert.match(validateMemberChange({ ...change, add: ['c'], remove: ['c'] }) ?? '', /不能同时/)
  assert.match(validateMemberChange({ ...change, add: ['b'] }) ?? '', /已在群内/)
  assert.match(validateMemberChange({ ...change, remove: ['c'] }) ?? '', /不在群内/)
  assert.match(validateMemberChange({ ...change, remove: ['a'] }) ?? '', /协调人不能移出/)
  const full = Array.from({ length: 32 }, (_, i) => `m${i}`)
  assert.match(validateMemberChange({ currentIds: full, coordinatorId: 'm0', add: ['x'], remove: [] }) ?? '', /1–32/)
  assert.equal(validateMemberChange({ currentIds: full, coordinatorId: 'm0', add: ['x'], remove: ['m1'] }), null)
  assert.equal(validateMemberChange({ ...change, add: ['c'] }), null)
})

test('rule text is decoded for editing and its references are found in either form', () => {
  assert.equal(decodeGroupPrompt('1. @{a} → @{b}：交付 @{gone}', bindings), '1. @【销售】 → @【技术】：交付 @{gone}')
  assert.deepEqual(promptReferences('@【销售】 → @{b}', bindings).sort(), ['a', 'b'])
  assert.deepEqual(removedReferences('@【销售】 → @【技术】', bindings, ['b', 'c']), ['技术'])
  assert.deepEqual(removedReferences('只有目标，没有引用', bindings, ['b']), [])
})

test('adding a member to an automatic group sends only the roster change', () => {
  const plan = planMemberUpdate({ change: { ...change, add: ['c'] }, orchestration: { mode: 'auto' }, ruleText: '', bindings })
  assert.deepEqual(plan, { request: { add_employee_ids: ['c'] } })
})

test('an untouched custom rule is not rewritten when members change', () => {
  const rule = custom('1. @{a} → @{b}：交付')
  const text = decodeGroupPrompt(rule.prompt, bindings)
  const plan = planMemberUpdate({ change: { ...change, add: ['c'] }, orchestration: rule, ruleText: text, bindings })
  assert.deepEqual(plan, { request: { add_employee_ids: ['c'] } })
})

test('removing a member that the rule still names is refused before any request', () => {
  const rule = custom('1. @{a} → @{b}：交付')
  const plan = planMemberUpdate({ change: { ...change, remove: ['b'] }, orchestration: rule, ruleText: decodeGroupPrompt(rule.prompt, bindings), bindings })
  assert.ok('error' in plan)
  assert.match(plan.error, /已移除或无效|未选入群/)
})

test('a rewritten rule travels with the member change in one request', () => {
  const rule = custom('1. @{a} → @{b}：交付')
  const plan = planMemberUpdate({
    change: { ...change, add: ['c'], remove: ['b'] },
    orchestration: rule,
    ruleText: '1. @【销售】 → @【项目经理】：整理排期',
    bindings,
  })
  assert.deepEqual(plan, {
    request: {
      add_employee_ids: ['c'],
      remove_employee_ids: ['b'],
      orchestration: custom('1. @{a} → @{c}：整理排期'),
    },
  })
})

test('a custom rule cannot be emptied while editing members', () => {
  const plan = planMemberUpdate({ change: { ...change, add: ['c'] }, orchestration: custom('@{a}'), ruleText: '   ', bindings })
  assert.deepEqual(plan, { error: '协作提示词不能为空。' })
})

test('switching to automatic needs a description and sends it along', () => {
  const base = { target: 'auto' as const, ruleText: '', memberIds: ['a', 'b'], bindings }
  assert.deepEqual(planOrchestrationUpdate({ ...base, description: '   ' }), { error: '自动编排需要填写群简介。' })
  assert.deepEqual(planOrchestrationUpdate({ ...base, description: ' 课程协作 ' }), {
    request: { orchestration: { mode: 'auto' }, description: '课程协作' },
  })
  assert.ok('error' in planOrchestrationUpdate({ ...base, description: 'x'.repeat(4001) }))
})

test('saving a custom rule encodes friendly references and rejects members outside the group', () => {
  const base = { target: 'custom' as const, description: '', memberIds: ['a', 'b'], bindings }
  assert.deepEqual(planOrchestrationUpdate({ ...base, ruleText: '  1. @【销售】 → @【技术】：交付  ' }), {
    request: { orchestration: custom('1. @{a} → @{b}：交付') },
  })
  assert.ok('error' in planOrchestrationUpdate({ ...base, ruleText: '@【项目经理】：排期' }))
  assert.deepEqual(planOrchestrationUpdate({ ...base, ruleText: '  ' }), { error: '请填写协作提示词。' })
  assert.ok('error' in planOrchestrationUpdate({ ...base, ruleText: 'x'.repeat(16_001) }))
})

test('edit failures are explained in user terms for every documented server code', () => {
  const cases: [unknown, RegExp][] = [
    [{ status: 409, code: 'conversation_busy' }, /正在执行/],
    [{ status: 422, code: 'invalid_orchestration_reference' }, /改写规则/],
    [{ status: 422, code: 'invalid_group_coordinator' }, /协调人/],
    [{ status: 422, code: 'invalid_group_members' }, /刷新群成员/],
    [{ status: 422, code: 'invalid_group_orchestration' }, /编排规则/],
    [{ status: 422, code: 'invalid_group_configuration' }, /不是自选成员群.*简介/],
    [{ status: 403, code: 'employee_not_authorized' }, /授权已变化/],
    [{ status: 404 }, /暂不支持/],
    [{ status: 403 }, /没有权限/],
    [{ status: 409 }, /状态已变化/],
  ]
  for (const [error, expected] of cases) assert.match(describeGroupEditError(error, '兜底'), expected)
  assert.equal(describeGroupEditError(new Error('Internal server error'), '兜底'), '兜底')
  assert.equal(describeGroupEditError(undefined, '兜底'), '兜底')
})

const client = (request: (options: any) => any) => ({ request }) as AgentApiClient

test('editing capability is detected per endpoint from the service OpenAPI', async () => {
  const schema = (paths: object) => client(async () => ({ paths }))
  assert.deepEqual(await supportsGroupEditing(schema({})), NO_GROUP_EDITING)
  assert.deepEqual(await supportsGroupEditing(schema({ [GROUP_PARTICIPANTS_PATH]: { get: {} } })), NO_GROUP_EDITING)
  assert.deepEqual(await supportsGroupEditing(schema({ [GROUP_PARTICIPANTS_PATH]: { get: {}, patch: {} } })), { members: true, orchestration: false })
  assert.deepEqual(await supportsGroupEditing(schema({ [GROUP_ORCHESTRATION_PATH]: { put: {} } })), { members: false, orchestration: true })
})

test('member and rule edits call the documented routes with encoded IDs', async () => {
  const requests: any[] = []
  const recorder = client(async options => { requests.push(options); return {} })
  await updateGroupMembers(recorder, 'g/1', { add_employee_ids: ['c'] })
  await replaceGroupOrchestration(recorder, 'g/1', { orchestration: { mode: 'auto' }, description: '用途' }, true)
  await replaceGroupOrchestration(recorder, 'g/1', { orchestration: { mode: 'auto' }, description: '用途' }, false)
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ['PATCH', '/api/agent/conversations/g%2F1/participants'],
    ['PUT', '/api/agent/conversations/g%2F1/orchestration'],
    ['PATCH', '/api/agent/conversations/g%2F1'],
  ])
  assert.deepEqual(requests[0].body, { add_employee_ids: ['c'] })
  assert.deepEqual(requests[1].body, requests[2].body)
})

test('the manage-members entry explains why it is unavailable instead of disappearing', () => {
  const ready = { isCustomGroup: true, rosterLoaded: true, capabilities: { members: true } }
  assert.deepEqual(memberEditAvailability(ready), { enabled: true })
  const solution = memberEditAvailability({ ...ready, isCustomGroup: false })
  assert.ok(!solution.enabled && /不是自选成员群.*创建群聊/.test(solution.reason ?? ''))
  const unloaded = memberEditAvailability({ ...ready, rosterLoaded: false })
  assert.ok(!unloaded.enabled && /尚未读取成功/.test(unloaded.reason ?? ''))
  const old = memberEditAvailability({ ...ready, capabilities: { members: false } })
  assert.ok(!old.enabled && /升级 Agent/.test(old.reason ?? ''))
  // 探测中：先置灰，不提前宣布“不支持”。
  assert.deepEqual(memberEditAvailability({ ...ready, capabilities: null }), { enabled: false, reason: null })
})
