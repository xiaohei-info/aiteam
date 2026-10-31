import assert from 'node:assert/strict'
import test from 'node:test'
import { createCustomGroup, supportsCustomGroups, CUSTOM_GROUP_PATH } from '../src/api/agent/customGroups.ts'
import type { CustomGroupCreateRequest } from '../src/api/agent/customGroups.ts'
import type { AgentApiClient } from '../src/api/agent/client.ts'
import { encodeGroupPrompt, groupPromptTemplate, mentionBindings, validateGroupRequest } from '../src/lib/customGroupForm.ts'

const input: CustomGroupCreateRequest = { id: 'fixed', title: '群', description: '群用途', member_employee_ids: ['a', 'b'], coordinator_employee_id: 'a', orchestration: { mode: 'auto' } }
const members = { employee_count: 2, participants: [{ employee_id: 'a' }, { employee_id: 'b' }] }
const conversation = { ...input, kind: 'group', permission_mode: 'read-only' }
const client = (request: (options: any) => any) => ({ request }) as AgentApiClient

test('custom group uses the new endpoint and reads authoritative participants', async () => {
  const requests: any[] = []
  const result = await createCustomGroup(client(async options => {
    requests.push(options)
    return options.method === 'POST' ? conversation : members
  }), input)
  assert.equal(requests[0].path, CUSTOM_GROUP_PATH)
  assert.deepEqual(requests[0].body, input)
  assert.equal(requests[1].path, '/api/agent/conversations/fixed/participants')
  assert.equal(result.participants?.employee_count, 2)
})

test('lost create responses recover the same ID only after checking config and members', async () => {
  for (const status of [0, 409, 500]) {
    let posts = 0
    const result = await createCustomGroup(client(async options => {
      if (options.method === 'POST') { posts++; throw Object.assign(new Error('lost'), { status }) }
      return options.path.endsWith('/participants') ? members : conversation
    }), input)
    assert.equal(result.conversation.id, input.id)
    assert.equal(posts, 1)
  }
  await assert.rejects(createCustomGroup(client(async options => {
    if (options.method === 'POST') throw Object.assign(new Error('exists'), { status: 409 })
    return options.path.endsWith('/participants') ? { ...members, participants: [{ employee_id: 'a' }] } : conversation
  }), input), /不同配置/)
})

test('member read failures do not turn successful creation into another POST', async () => {
  let posts = 0
  const result = await createCustomGroup(client(async options => {
    if (options.method === 'POST') { posts++; return conversation }
    throw new Error('member read unavailable')
  }), input)
  assert.equal(result.conversation.id, input.id)
  assert.equal(result.participants, null)
  assert.equal(posts, 1)
})

test('old service capability is detected without creating a legacy group', async () => {
  assert.equal(await supportsCustomGroups(client(async () => ({ paths: {} }))), false)
  assert.equal(await supportsCustomGroups(client(async () => ({ paths: { [CUSTOM_GROUP_PATH]: { post: {} } } }))), true)
})

test('friendly references distinguish same-name employees and reject removed members', () => {
  const bindings = mentionBindings([{ employeeId: 'a', displayName: '专家' }, { employeeId: 'b', displayName: '专家' }])
  assert.notEqual(bindings[0].label, bindings[1].label)
  const text = `@【${bindings[0].label}】 → @【${bindings[1].label}】：交付`
  assert.equal(encodeGroupPrompt(text, bindings, ['a', 'b']), '@{a} → @{b}：交付')
  assert.throws(() => encodeGroupPrompt(text, bindings, ['a']), /已移除/)
  assert.throws(() => encodeGroupPrompt('@{outsider}', bindings, ['a']), /未选入群/)
  assert.throws(() => encodeGroupPrompt('@【专家', bindings, ['a']), /不完整/)
  assert.match(groupPromptTemplate(bindings), /协作目标：[\s\S]*协作流程：[\s\S]*最终交付：/)
})

test('automatic and custom validation keep mode-specific fields separate', () => {
  assert.equal(validateGroupRequest(input), null)
  assert.match(validateGroupRequest({ ...input, description: '' })!, /群简介/)
  assert.match(validateGroupRequest({ ...input, coordinator_employee_id: 'other' })!, /协调人/)
  assert.match(validateGroupRequest({ ...input, title: 'a'.repeat(201) })!, /200/)
  assert.match(validateGroupRequest({ ...input, member_employee_ids: ['a', 'a'] })!, /重复/)
  const custom = { ...input, description: null, orchestration: { mode: 'custom' as const, format: 'collaboration-markdown-v1' as const, prompt: '1. @{a} → @{b}：交付' } }
  assert.equal(validateGroupRequest(custom), null)
  assert.match(validateGroupRequest({ ...custom, orchestration: { ...custom.orchestration, prompt: '' } })!, /提示词/)
})
