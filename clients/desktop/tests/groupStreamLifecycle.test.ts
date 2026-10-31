import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettleTracker } from '../src/lib/groupStreamLifecycle.ts'
import { resolveGroupPromptRoute } from '../src/lib/groupPrompt.ts'

test('群聊等待全部预期员工 settled，重复事件不重复完成', () => {
  let completes = 0
  const tracker = createSettleTracker({
    mode: 'group',
    expectedEmployeeIds: ['worker-a', 'worker-b', 'worker-a'],
    expectedTargetsKnown: true,
    onComplete: () => { completes += 1 },
  })

  tracker.markRunning('worker-a')
  tracker.markRunning('worker-b')
  tracker.markSettled('worker-a')
  tracker.markSettled('worker-a')

  assert.equal(tracker.isDone(), false)
  assert.equal(completes, 0)
  assert.deepEqual(tracker.getSnapshot().participants, {
    'worker-a': 'settled',
    'worker-b': 'running',
  })

  tracker.markSettled('worker-b')
  tracker.markSettled('worker-b')
  assert.equal(tracker.isDone(), true)
  assert.equal(completes, 1)
})

test('运行中观察到的动态 child 会加入同一轮并阻止提前完成', () => {
  let completes = 0
  const tracker = createSettleTracker({
    mode: 'group',
    expectedEmployeeIds: ['coordinator'],
    expectedTargetsKnown: true,
    onComplete: () => { completes += 1 },
  })

  tracker.markRunning('coordinator')
  tracker.markRunning('dynamic-worker')
  tracker.markSettled('coordinator')
  assert.equal(tracker.isDone(), false)

  tracker.markSettled('dynamic-worker')
  assert.equal(tracker.isDone(), true)
  assert.equal(completes, 1)
})

test('未知目标群聊不能由首个或无来源 settled 结束，只接受会话聚合终态', () => {
  let completes = 0
  const tracker = createSettleTracker({
    mode: 'group',
    expectedTargetsKnown: false,
    onComplete: () => { completes += 1 },
  })

  tracker.markSettled(undefined)
  tracker.markRunning('observed-worker')
  tracker.markSettled('observed-worker')
  assert.equal(tracker.isDone(), false)
  assert.equal(completes, 0)

  tracker.markConversationEnded()
  assert.equal(tracker.isDone(), true)
  assert.equal(completes, 1)
})

test('单聊兼容缺少 source_employee_id 的 agent_settled', () => {
  let completes = 0
  const tracker = createSettleTracker({
    mode: 'single',
    onComplete: () => { completes += 1 },
  })

  tracker.markSettled(undefined)
  tracker.markSettled(undefined)
  assert.equal(tracker.isDone(), true)
  assert.equal(completes, 1)
})

test('mentions 按 handle 推导 fan-out 目标，无 mentions 只路由 coordinator', () => {
  const group = {
    id: 'group-1',
    members: [
      {
        employee_id: 'coordinator', member_ref_id: 'coordinator', member_id: 'coordinator',
        display_name: '主持人', handle: 'coord', is_system_planner: true,
      },
      {
        employee_id: 'worker-a', member_ref_id: 'worker-a', member_id: 'worker-a',
        display_name: '员工 A', handle: 'a',
      },
      {
        employee_id: 'worker-b', member_ref_id: 'worker-b', member_id: 'worker-b',
        display_name: '员工 B', handle: 'b',
      },
    ],
  }

  assert.deepEqual(resolveGroupPromptRoute(group, undefined), {
    targetEmployeeIds: ['coordinator'],
    targetsKnown: true,
  })
  assert.deepEqual(resolveGroupPromptRoute(group, ['a', 'b', 'a']), {
    targetEmployeeIds: ['worker-a', 'worker-b'],
    targetsKnown: true,
  })
  assert.deepEqual(resolveGroupPromptRoute(group, ['missing']), {
    targetEmployeeIds: [],
    targetsKnown: false,
  })
})

test('同一员工的新 work 重新计入运行，不能沿用上一 work 的 settled', () => {
  let completes = 0
  const tracker = createSettleTracker({ mode: 'group', expectedEmployeeIds: ['coordinator', 'worker'], expectedTargetsKnown: true, onComplete: () => { completes++ } })
  tracker.markSettled('worker')
  tracker.markRunning('worker', true)
  tracker.markSettled('coordinator')
  assert.equal(tracker.isDone(), false)
  tracker.markSettled('worker')
  assert.equal(completes, 1)
})
