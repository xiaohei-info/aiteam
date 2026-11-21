import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityUpdateLabel, countCapabilityUpdates, shouldCheckOnFocus } from '../src/lib/capabilityUpdates.ts'

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
