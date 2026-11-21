import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityUpdateLabel, countCapabilityUpdates, createCapabilityChecker, firstCheckDelay, shouldCheckOnFocus } from '../src/lib/capabilityUpdates.ts'

test('只数本机已装且有新版本的技能和 MCP', () => {
  const counts = countCapabilityUpdates(
    [
      { state: 'update', local_ref: 'weekly-report' },
      { state: 'update' },
      { state: 'installed', local_ref: 'notes' },
      { state: 'conflict', local_ref: 'ppt' },
      { state: 'install' },
    ],
    [{ state: 'update' }, { state: 'installed' }, { state: 'conflict' }, { state: 'install' }],
  )
  assert.deepEqual(counts, { skills: 1, mcps: 1 })
})

test('没有更新时为 0', () => {
  assert.deepEqual(countCapabilityUpdates([], []), { skills: 0, mcps: 0 })
})

test('切回窗口：从未检查过或间隔够了才检查', () => {
  assert.equal(shouldCheckOnFocus(null, 1_000), true)
  assert.equal(shouldCheckOnFocus(1_000, 30_000), false)
  assert.equal(shouldCheckOnFocus(1_000, 61_000), true)
})

test('红点读屏文案', () => {
  assert.equal(capabilityUpdateLabel(3), '3 项有更新')
})


function fakeChecker(replying = { now: false }) {
  const calls: string[] = []
  let release: (() => void) | null = null
  const checker = createCapabilityChecker({
    syncGrants: async () => { calls.push('sync') },
    isReplying: () => replying.now,
    readCatalogs: () => new Promise<void>((resolve) => { calls.push('read'); release = resolve }),
  })
  const finishRead = async () => { while (!release) await Promise.resolve(); const r = release; release = null; r() }
  return { checker, calls, finishRead, replying }
}

test('检查进行中又来「要同步」：不丢，跑完接着补一次同步', async () => {
  const { checker, calls, finishRead } = fakeChecker()
  const first = checker.check()
  const second = checker.check({ syncGrants: true })
  assert.equal(first, second)
  await finishRead()
  await finishRead()
  await first
  assert.deepEqual(calls, ['read', 'sync', 'read'])
})

test('正在回复时不同步，记下；回复结束后的检查先补上同步', async () => {
  const { checker, calls, finishRead, replying } = fakeChecker({ now: true })
  const during = checker.check({ syncGrants: true })
  await finishRead()
  await during
  assert.deepEqual(calls, ['read'])
  assert.equal(checker.hasDeferredSync(), true)
  replying.now = false
  const after = checker.check()
  await finishRead()
  await after
  assert.deepEqual(calls, ['read', 'sync', 'read'])
  assert.equal(checker.hasDeferredSync(), false)
})

test('reset 清掉排队与推迟的同步；不要求同步的检查只读目录', async () => {
  const { checker, calls, finishRead, replying } = fakeChecker({ now: true })
  const pending = checker.check({ syncGrants: true })
  await finishRead()
  await pending
  checker.reset()
  replying.now = false
  const plain = checker.check()
  await finishRead()
  await plain
  assert.deepEqual(calls, ['read', 'read'])
})

test('首次检查随机延迟在 0–60 秒内', () => {
  assert.equal(firstCheckDelay(() => 0), 0)
  assert.equal(firstCheckDelay(() => 0.5), 30_000)
  assert.equal(firstCheckDelay(() => 1), 60_000)
  assert.equal(firstCheckDelay(() => 7), 60_000)
})
