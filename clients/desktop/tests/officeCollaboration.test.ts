import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSseEvent } from '../src/api/agent/events.ts'
import {
  CollaborationTracker,
  buildMentionResolver,
  parseCollabSignal,
  parseReconciliationSignals,
  sameIntents,
  type CollabSignal,
} from '../src/lib/officeCollaboration.ts'

const CONV = 'conv-1'

function toolStart(from: string, ref: string, id: string, toolName = 'mention_employee'): AgentSseEvent {
  return { type: 'tool_execution_start', conversation_id: CONV, source_employee_id: from, toolName, toolCallId: id, args: { employee_id: ref, message: 'hi' } }
}

function toolEnd(from: string, id: string, toolName = 'mention_employee'): AgentSseEvent {
  return { type: 'tool_execution_end', conversation_id: CONV, source_employee_id: from, toolName, toolCallId: id }
}

const roster = [
  { id: 'emp_a', name: '小A', handle: 'alice' },
  { id: 'emp_b', name: '小B', handle: 'bob' },
  { id: 'emp_c', name: '小C', handle: 'carol' },
  { id: 'emp_d', name: '小D', handle: 'dave' },
]
const resolve = buildMentionResolver(roster)

/** 用事件驱动 tracker，返回某个时刻的协作计划 */
function run(tracker: CollaborationTracker, events: Array<[number, AgentSseEvent]>): void {
  for (const [at, event] of events) {
    const signal = parseCollabSignal(event, CONV)
    if (signal) tracker.apply(signal, at)
  }
}

test('信号解析：mention_employee 开始 / 结束，兼容别名，忽略其他工具', () => {
  assert.deepEqual(parseCollabSignal(toolStart('emp_a', 'bob', 't1'), CONV), {
    phase: 'start', key: `${CONV}:t1`, conversationId: CONV, from: 'emp_a', toRef: 'bob',
  })
  assert.equal(parseCollabSignal(toolStart('emp_a', 'bob', 't1', 'delegate_employee'), CONV)?.phase, 'start')
  assert.deepEqual(parseCollabSignal(toolEnd('emp_a', 't1'), CONV), { phase: 'end', key: `${CONV}:t1` })
  assert.equal(parseCollabSignal(toolStart('emp_a', 'bob', 't1', 'bash'), CONV), null)
  assert.equal(parseCollabSignal({ type: 'tool_execution_start', toolName: 'mention_employee', toolCallId: 't2', args: { employee_id: 'bob' } }, CONV), null, '缺少发起人不算')
  assert.equal(parseCollabSignal({ type: 'tool_execution_start', source_employee_id: 'emp_a', toolName: 'mention_employee', toolCallId: 't3', args: {} }, CONV), null, '缺少目标不算')
})

test('信号解析：员工本轮结束视为其发出的 @ 收尾；会话 id 缺省用订阅的会话', () => {
  const settled = parseCollabSignal({ type: 'agent_settled', source_employee_id: 'emp_a' }, CONV)
  assert.deepEqual(settled, { phase: 'settled', conversationId: CONV, from: 'emp_a' })
  assert.equal(parseCollabSignal({ type: 'agent_end' }, CONV), null)
})

test('信号解析：信封里继承的 tool_call_id 不能盖过工具事件自己的调用 id', () => {
  const event: AgentSseEvent = { ...toolStart('emp_a', 'bob', 'own-id'), tool_call_id: 'parent-id' }
  assert.equal((parseCollabSignal(event, CONV) as Extract<CollabSignal, { phase: 'start' }>).key, `${CONV}:own-id`)
})

test('重连快照：还没有 toolResult 的 mention 调用补成开始，已回复的不补', () => {
  const snapshot = {
    schema_version: '2',
    type: 'reconciliation',
    conversation_id: CONV,
    state: 'running',
    prompting: true,
    entries: [{ id: 'e1', type: 'message', message: { role: 'toolResult', toolCallId: 'done' } }],
    active_runs: [{
      source_employee_id: 'emp_a',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我去问问' },
          { type: 'toolCall', id: 'pending', name: 'mention_employee', arguments: { employee_id: 'bob' } },
          { type: 'toolCall', id: 'done', name: 'mention_employee', arguments: { employee_id: 'carol' } },
          { type: 'toolCall', id: 'other', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
    }],
  } as unknown as AgentSseEvent
  const signals = parseReconciliationSignals(snapshot, CONV)
  assert.deepEqual(signals, [{ phase: 'start', key: `${CONV}:pending`, conversationId: CONV, from: 'emp_a', toRef: 'bob' }])
  assert.deepEqual(parseReconciliationSignals(toolStart('emp_a', 'bob', 't'), CONV), [])
})

test('被 @ 的引用：按 id / handle / @handle / 显示名解析，重名不猜', () => {
  assert.equal(resolve('emp_b'), 'emp_b')
  assert.equal(resolve('bob'), 'emp_b')
  assert.equal(resolve('@bob'), 'emp_b')
  assert.equal(resolve('小B'), 'emp_b')
  assert.equal(resolve('nobody'), null)
  const dup = buildMentionResolver([{ id: 'x1', name: '同名' }, { id: 'x2', name: '同名' }])
  assert.equal(dup('同名'), null)
})

test('A @ B 存活超过去抖时间 → 串门：A 去 B 的工位旁', () => {
  const tracker = new CollaborationTracker({ debounceMs: 800 })
  run(tracker, [[1000, toolStart('emp_a', 'bob', 't1')]])
  assert.deepEqual(tracker.plan(1300, resolve), [], '不足去抖时间不动')
  assert.deepEqual(tracker.plan(2000, resolve), [{ kind: 'visit', key: `visit:${CONV}:emp_a>emp_b`, visitor: 'emp_a', host: 'emp_b' }])
})

test('秒失败 / 重放的 @（开始后马上结束）不会让人白跑一趟', () => {
  const tracker = new CollaborationTracker({ debounceMs: 800, lingerMs: 6000 })
  run(tracker, [[1000, toolStart('emp_a', 'bob', 't1')], [1100, toolEnd('emp_a', 't1')]])
  assert.deepEqual(tracker.plan(1200, resolve), [])
  assert.deepEqual(tracker.plan(5000, resolve), [])
})

test('B 回复后串门保持一会儿再散场（linger），之后消失', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 6000 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.equal(tracker.plan(1000, resolve).length, 1)
  run(tracker, [[5000, toolEnd('emp_a', 't1')]])
  assert.equal(tracker.plan(8000, resolve).length, 1, '回复后还在聊')
  assert.equal(tracker.plan(5000 + 6001 + 1000, resolve).length, 0, '过了 linger 散场')
})

test('A 同时 @B、@C → 会议：A、B、C 全员进会议室', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')], [50, toolStart('emp_a', 'carol', 't2')]])
  const [intent] = tracker.plan(1000, resolve)
  assert.equal(intent.kind, 'meeting')
  assert.deepEqual([...(intent as { members: string[] }).members].sort(), ['emp_a', 'emp_b', 'emp_c'])
  assert.equal(intent.key, `meeting:${CONV}`)
})

test('B 在被 @ 期间又 @ 了 C → 三人协作，升级为会议；成员只增不减直到散会', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 6000 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.equal(tracker.plan(1000, resolve)[0].kind, 'visit')
  run(tracker, [[1500, toolStart('emp_b', 'carol', 't2')]])
  const meeting = tracker.plan(2500, resolve)[0] as { kind: string; members: string[] }
  assert.equal(meeting.kind, 'meeting')
  assert.equal(meeting.members.length, 3)

  // C 先回复、A 的 @ 还在：成员不会缩回去
  run(tracker, [[3000, toolEnd('emp_b', 't2')]])
  assert.equal((tracker.plan(3500, resolve)[0] as { members: string[] }).members.length, 3)
  // 又有 D 加入：成员增加
  run(tracker, [[4000, toolStart('emp_a', 'dave', 't3')]])
  assert.equal((tracker.plan(5000, resolve)[0] as { members: string[] }).members.length, 4)
})

test('顺序 @（A→B 结束后 A→C）：串门对象跟着换，不会误判成会议', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 6000 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')], [3000, toolEnd('emp_a', 't1')], [3200, toolStart('emp_a', 'carol', 't2')]])
  const [intent] = tracker.plan(4000, resolve)
  assert.equal(intent.kind, 'visit')
  assert.equal((intent as { host: string }).host, 'emp_c')
})

test('解析不了的 @（不在花名册 / @ 自己）不产生协作；花名册后到也不丢', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500 })
  run(tracker, [[0, toolStart('emp_a', 'ghost', 't1')], [0, toolStart('emp_a', 'alice', 't2')]])
  assert.deepEqual(tracker.plan(1000, resolve), [])
  const late = new CollaborationTracker({ debounceMs: 500 })
  run(late, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.deepEqual(late.plan(1000, buildMentionResolver([])), [])
  assert.equal(late.plan(1100, resolve).length, 1)
})

test('不同会话互不影响；会话关闭后未结束的 @ 收尾并渐退', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 6000 })
  tracker.apply({ phase: 'start', key: 'c1:t1', conversationId: 'c1', from: 'emp_a', toRef: 'bob' }, 0)
  tracker.apply({ phase: 'start', key: 'c2:t1', conversationId: 'c2', from: 'emp_c', toRef: 'dave' }, 0)
  assert.equal(tracker.plan(1000, resolve).length, 2)
  tracker.closeConversation('c1', 2000)
  assert.equal(tracker.plan(3000, resolve).length, 2, '渐退期内仍在')
  const later = tracker.plan(2000 + 6001 + 1000, resolve)
  assert.equal(later.length, 1)
  assert.equal(later[0].key.startsWith('visit:c2:'), true)
})

test('员工本轮结束（settled）收尾其发出的 @；丢了 end 帧超过 staleMs 也会收尾', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 1000, staleMs: 10_000 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.equal(tracker.plan(1000, resolve).length, 1, '正在进行时已成立')
  run(tracker, [[2000, { type: 'agent_settled', conversation_id: CONV, source_employee_id: 'emp_a' }]])
  assert.equal(tracker.plan(2500, resolve).length, 1)
  assert.equal(tracker.plan(4000, resolve).length, 0)

  const lost = new CollaborationTracker({ debounceMs: 500, lingerMs: 1000, staleMs: 10_000 })
  run(lost, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.equal(lost.plan(5000, resolve).length, 1)
  lost.plan(12_000, resolve)
  assert.equal(lost.plan(14_000, resolve).length, 0)
})

test('同一条 @ 重复开始（重放 / 重连）幂等；plan 多次调用结果一致', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')], [200, toolStart('emp_a', 'bob', 't1')]])
  const first = tracker.plan(1000, resolve)
  const second = tracker.plan(1000, resolve)
  assert.equal(first.length, 1)
  assert.ok(sameIntents(first, second))
})

test('意图比较：成员顺序或种类变化都算不同', () => {
  const visit = { kind: 'visit' as const, key: 'k', visitor: 'a', host: 'b' }
  const meeting = { kind: 'meeting' as const, key: 'k', members: ['a', 'b', 'c'] }
  assert.ok(sameIntents([visit], [{ ...visit }]))
  assert.ok(!sameIntents([visit], [meeting]))
  assert.ok(!sameIntents([meeting], [{ ...meeting, members: ['a', 'b', 'd'] }]))
  assert.ok(!sameIntents([meeting], []))
})

test('会议入口关闭（meetingsEnabled: false）：A 同时 @B、@C 不进会议室，也不拆成串门', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, meetingsEnabled: false })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')], [50, toolStart('emp_a', 'carol', 't2')]])
  assert.deepEqual(tracker.plan(1000, resolve), [])
  assert.deepEqual(tracker.plan(30_000, resolve), [], '期间始终没有任何意图')
})

test('会议入口关闭：两人协作的串门不受影响', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, meetingsEnabled: false })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.deepEqual(tracker.plan(1000, resolve), [{ kind: 'visit', key: `visit:${CONV}:emp_a>emp_b`, visitor: 'emp_a', host: 'emp_b' }])
})

test('会议入口关闭：已经在串门时第三人加入，不升级成会议，串门保持到结束再散场', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500, lingerMs: 6000, meetingsEnabled: false })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')]])
  assert.equal(tracker.plan(1000, resolve)[0].kind, 'visit')
  run(tracker, [[1500, toolStart('emp_b', 'carol', 't2')]])
  const during = tracker.plan(2500, resolve)
  assert.deepEqual(during.map((intent) => intent.kind), ['visit'])
  run(tracker, [[4000, toolEnd('emp_b', 't2')], [4500, toolEnd('emp_a', 't1')]])
  assert.equal(tracker.plan(6000, resolve).length, 1, '结束后仍在 linger 期内')
  assert.equal(tracker.plan(4500 + 6001 + 1000, resolve).length, 0)
})

test('会议入口默认开启：不传选项时 ≥3 人协作仍产出会议意图（执行逻辑保留）', () => {
  const tracker = new CollaborationTracker({ debounceMs: 500 })
  run(tracker, [[0, toolStart('emp_a', 'bob', 't1')], [50, toolStart('emp_a', 'carol', 't2')]])
  assert.equal(tracker.plan(1000, resolve)[0].kind, 'meeting')
})
