import assert from 'node:assert/strict'
import test from 'node:test'
import {
  entriesToMessages,
  resolvePiEventSenderIdentity,
} from '../src/lib/piConverters.ts'
import { submitGroupPrompt } from '../src/lib/groupPrompt.ts'

test('用户条目不会被旧 employee fallback 标记成 AI 员工', () => {
  const [message] = entriesToMessages([{
    id: 'entry-user',
    type: 'message',
    message: { role: 'user', content: '开始分析' },
    source_type: 'human',
    source_role: 'human',
    // 旧服务端曾错误附带这两个字段；显式 human 来源必须优先。
    source_employee_id: 'coordinator',
    source_employee_display_name: '主持人',
  }])

  assert.equal(message?.role, 'user')
  assert.equal(message?.senderName, undefined)
  assert.equal(message?.senderEmployeeId, undefined)
  assert.equal(message?.senderRole, 'human')
})

test('主持人和普通成员的历史身份与流式身份一致', () => {
  for (const source of [
    { id: 'coordinator', name: '主持人', role: 'coordinator' as const },
    { id: 'worker', name: '普通成员', role: 'participant' as const },
  ]) {
    const [history] = entriesToMessages([{
      id: `entry-${source.id}`,
      type: 'message',
      message: { role: 'assistant', content: '已完成' },
      source_employee_id: source.id,
      source_employee_display_name: source.name,
      source_role: source.role,
    }])
    const streaming = resolvePiEventSenderIdentity({
      type: 'message_update',
      source_employee_id: source.id,
      source_employee_display_name: source.name,
      source_role: source.role,
    })

    assert.equal(history?.role, 'assistant')
    assert.deepEqual(
      {
        senderName: history?.senderName,
        senderEmployeeId: history?.senderEmployeeId,
        senderRole: history?.senderRole,
      },
      streaming,
    )
  }
})

test('员工转交消息只在 source_type 明确为 employee 时按成员身份展示', () => {
  const [message] = entriesToMessages([{
    id: 'entry-delegated',
    type: 'message',
    message: { role: 'user', content: '请继续处理' },
    source_type: 'employee',
    source_id: 'worker',
    source_display_name: '普通成员',
    source_role: 'participant',
  }])

  assert.equal(message?.role, 'assistant')
  assert.equal(message?.senderEmployeeId, 'worker')
  assert.equal(message?.senderName, '普通成员')
  assert.equal(message?.senderRole, 'participant')
})

test('群聊委派仅凭 participant ID 从目录解析不同目标，保持发送者身份', () => {
  const [msg1, msg2] = entriesToMessages([
    {
      id: 'entry-delegate-fe',
      type: 'message',
      message: { role: 'user', content: '请完成前端页面开发' },
      source_type: 'employee',
      source_id: 'coord-pm',
      source_display_name: '产品经理',
      source_role: 'coordinator',
      participant_employee_id: 'worker-fe',
    },
    {
      id: 'entry-delegate-hr',
      type: 'message',
      message: { role: 'user', content: '请完成前端页面开发' },
      source_type: 'employee',
      source_id: 'coord-pm',
      source_display_name: '产品经理',
      source_role: 'coordinator',
      participant_employee_id: 'worker-hr',
    },
  ], (id) => id === 'worker-fe' ? '前端工程师' : id === 'worker-hr' ? 'HR专员' : undefined)

  assert.equal(msg1?.senderName, '产品经理')
  assert.equal(msg1?.recipientEmployeeId, 'worker-fe')
  assert.equal(msg1?.recipientName, '前端工程师')

  assert.equal(msg2?.senderName, '产品经理')
  assert.equal(msg2?.recipientEmployeeId, 'worker-hr')
  assert.equal(msg2?.recipientName, 'HR专员')
})

test('目录未加载、未命中或姓名为空时保留目标 ID，不隐藏委派目标', () => {
  const entry = {
    id: 'entry-unknown-recipient',
    type: 'message',
    message: { role: 'user' as const, content: '请处理' },
    source_type: 'employee' as const,
    source_id: 'coordinator',
    source_display_name: '协调员工',
    participant_employee_id: 'revoked-worker',
  }
  for (const resolver of [undefined, () => undefined, () => '', () => '   ']) {
    const [message] = entriesToMessages([entry], resolver)
    assert.equal(message?.recipientEmployeeId, 'revoked-worker')
    assert.equal(message?.recipientName, 'revoked-worker')
    assert.equal(message?.senderName, '协调员工')
  }
})

test('忽略历史缓存里已撤销的目标姓名字段，以当前目录为准', () => {
  const entry = {
    id: 'entry-legacy-recipient',
    type: 'message',
    message: { role: 'user' as const, content: '请处理' },
    source_type: 'employee' as const,
    source_id: 'coordinator',
    participant_employee_id: 'worker',
    participant_employee_display_name: '过期姓名',
  }
  assert.equal(entriesToMessages([entry], () => '当前姓名')[0]?.recipientName, '当前姓名')
  assert.equal(entriesToMessages([entry])[0]?.recipientName, 'worker')
})

test('人类输入、员工自身条目和无目标条目不生成委派徽标', () => {
  for (const fields of [
    { source_type: 'human' as const, participant_employee_id: 'worker' },
    { source_type: 'employee' as const, source_id: 'worker', participant_employee_id: 'worker' },
    { source_type: 'employee' as const, source_id: 'worker' },
  ]) {
    const [message] = entriesToMessages([{
      id: 'entry-not-directed',
      type: 'message',
      message: { role: 'user', content: '你好' },
      ...fields,
    }], () => '员工')
    assert.equal(message?.recipientEmployeeId, undefined)
    assert.equal(message?.recipientName, undefined)
  }
})

test('只有主持人的群不依赖普通成员即可提交消息', async () => {
  const calls: unknown[][] = []
  const group = {
    id: 'group-coordinator-only',
    members: [{
      employee_id: 'coordinator',
      member_ref_id: 'coordinator',
      member_id: 'coordinator',
      display_name: '主持人',
      handle: 'coord',
      is_system_planner: true,
    }],
  }

  await submitGroupPrompt(group, '你好', undefined, 'idem-1', async (...args) => {
    calls.push(args)
  })

  assert.deepEqual(calls, [[group.id, { text: '你好' }, 'idem-1']])
})
