import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { SolutionProjection } from '../src/api/agent/types.ts'
import { GROUP_TITLE_EDIT_OWNERSHIP_NOTE, resolveGroupDetails } from '../src/lib/groupDetails.ts'

function solution(overrides: Partial<SolutionProjection> = {}): SolutionProjection {
  return {
    solution_instance_id: 'solution-1',
    display_name: '市场方案',
    version: '1:1',
    ...overrides,
  }
}

test('group details read the real solution description and coordinator instructions', () => {
  const details = resolveGroupDetails('solution-1', [solution({
    description: '负责跨渠道市场分析',
    coordinator_instructions: '主持人先拆解问题，再向成员分派任务。',
    workflow_skill_ref: { skill_id: 'workflow-1', version: '1.0.0' },
  })])

  assert.equal(details.description, '负责跨渠道市场分析')
  assert.equal(details.coordinatorInstructions, '主持人先拆解问题，再向成员分派任务。')
  assert.equal(details.descriptionMessage, null)
  assert.equal(details.orchestrationMessage, null)
  assert.equal(details.orchestrationMode, 'fixed')
  assert.equal(details.orchestrationModeLabel, '固定流程')
  assert.match(details.orchestrationModeMessage, /workflow_skill_ref/)
})

test('group details distinguish missing fields and unavailable projections', () => {
  const missingFields = resolveGroupDetails('solution-1', [solution()])
  assert.match(missingFields.descriptionMessage ?? '', /未提供群简介/)
  assert.equal(missingFields.orchestrationMessage, '会话编排字段未提供。')
  assert.equal(missingFields.orchestrationMode, 'unavailable')
  assert.equal(missingFields.orchestrationModeLabel, '编排模式不可用')
  assert.match(missingFields.orchestrationModeMessage, /无法确认/)

  const unavailable = resolveGroupDetails('solution-1', [])
  assert.match(unavailable.descriptionMessage ?? '', /投影当前不可用/)
  assert.match(unavailable.orchestrationMessage ?? '', /投影当前不可用/)
  assert.equal(unavailable.orchestrationMode, 'unavailable')
  assert.match(unavailable.orchestrationModeMessage, /投影当前不可用/)
})

test('a group with neither a saved rule nor a solution is described as not editable, not as missing server data', () => {
  const details = resolveGroupDetails(null, [])
  assert.equal(details.orchestrationMode, 'unavailable')
  assert.equal(details.orchestrationModeLabel, '未保存编排规则')
  assert.match(details.orchestrationModeMessage, /不是自选成员群.*没有保存编排规则/)
  // The reason is stated once, next to the label; no second "field not provided" line under it.
  assert.equal(details.orchestrationMessage, null)
  for (const text of [details.orchestrationModeLabel, details.orchestrationModeMessage]) assert.doesNotMatch(text, /服务端未提供|字段未提供|不可用/)
})

test('group details never infer a free orchestration mode from coordinator instructions', () => {
  const details = resolveGroupDetails('solution-1', [solution({
    coordinator_instructions: '根据问题动态选择成员。',
  })])

  assert.equal(details.coordinatorInstructions, '根据问题动态选择成员。')
  assert.equal(details.orchestrationMode, 'unavailable')
  assert.doesNotMatch(details.orchestrationModeLabel, /自由/)
})

test('group detail panel has no hard-coded empty placeholder', () => {
  const source = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, />空</)
  assert.match(source, /resolveGroupDetails\(group\.solutionInstanceId, groupSolutions, group\)/)
  assert.doesNotMatch(source, /addGroupMember|removeGroupMember/)
})

test('a group that is not a custom group says so once per card and does not offer a description edit the server rejects', () => {
  const source = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  // The server answers 422 invalid_group_configuration to a description change on such a group.
  assert.match(source, /disabled=\{!isCustomGroup\} onClick=\{handleStartDescriptionEdit\}/)
  assert.match(source, /isCustomGroup\s*\?\s*'群简介通过会话详情接口保存[^']*'\s*:\s*'该群不是自选成员群[^']*'/)
  // A rejected description save reports the real reason instead of "retry".
  assert.match(source, /describeGroupEditError\(error, '群简介保存失败，请重试。'\)/)
})

test('member management is gated on the service capability and custom groups', () => {
  const source = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /agentApi\.supportsGroupEditing\(\)/)
  assert.match(source, /memberEditAvailability\(/)
  assert.match(source, /disabled=\{!memberEdit\.enabled\}/)
  assert.match(source, /<GroupMembersDialog/)
})

test('group title and description use the owned conversation PATCH', () => {
  assert.match(GROUP_TITLE_EDIT_OWNERSHIP_NOTE, /自有本地会话/)
  assert.match(GROUP_TITLE_EDIT_OWNERSHIP_NOTE, /owner 校验/)

  const source = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /agentApi\.updateConversation\(group\.id, \{ title \}\)/)
  assert.match(source, /maxLength=\{200\}/)
  assert.match(source, /aria-label="保存群名称"/)
  assert.match(source, /agentApi\.updateConversation\(group\.id, \{ description: /)
})

test('orchestration card switches mode and saves through the group endpoint', () => {
  const panel = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  const card = readFileSync(
    new URL('../src/components/Chat/GroupOrchestrationCard.tsx', import.meta.url),
    'utf8',
  )

  assert.match(panel, /<GroupOrchestrationCard/)
  assert.match(panel, /dedicatedEndpoint=\{editCaps\?\.orchestration \?\? false\}/)
  assert.match(card, /details\.orchestrationMode/)
  assert.match(card, /details\.coordinatorInstructions/)
  assert.match(card, /agentApi\.replaceGroupOrchestration\(group\.id, plan\.request, dedicatedEndpoint\)/)
  assert.match(card, /aria-pressed=\{shown === value\}/)
  // 只读群（方案群、旧版群）不出现切换开关。
  assert.match(card, /const editable = current !== null && group\.rosterStatus === 'loaded'/)
  assert.doesNotMatch(card, /orchestration_mode|orchestration_rule|draggable|onDragEnd/)
})

test('group detail has no leave/dissolve entry while the service has no dedicated APIs and permission fields', () => {
  const panelSource = readFileSync(
    new URL('../src/components/Chat/GroupDetailPanel.tsx', import.meta.url),
    'utf8',
  )
  const conversationApiSource = readFileSync(
    new URL('../src/api/agent/conversations.ts', import.meta.url),
    'utf8',
  )
  const conversationTypesSource = readFileSync(
    new URL('../src/api/agent/types.ts', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(panelSource, /群管理/)
  assert.doesNotMatch(panelSource, /deleteConversation|leaveGroup|dissolveGroup|removeGroupMember/)
  assert.doesNotMatch(conversationApiSource, /leaveGroup|dissolveGroup|addGroupMember|removeGroupMember/)
  assert.doesNotMatch(conversationTypesSource, /created_by|creator_id|can_manage_members|can_disband/)
})


test('custom group details restore persisted description and employee references', () => {
  const details = resolveGroupDetails(null, [], {
    description: '自定义群用途', orchestration: { mode: 'custom', format: 'collaboration-markdown-v1', prompt: '1. @{a}：交付' },
    members: [{ employee_id: 'a', display_name: '销售顾问' }],
  })
  assert.equal(details.description, '自定义群用途')
  assert.equal(details.orchestrationMode, 'custom')
  assert.equal(details.coordinatorInstructions, '1. @销售顾问：交付')
  assert.equal(resolveGroupDetails(null, [], { description: '自动群', orchestration: { mode: 'auto' } }).orchestrationMode, 'auto')
})
