import assert from 'node:assert/strict'
import test from 'node:test'
import { isOutcomeBubbleMuted, OUTCOME_BUBBLE_STORAGE_KEY, setOutcomeBubbleMuted } from '../src/lib/contextOutcomeBubble.ts'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

test('「不再提示」 persists on this device and settings can turn the bubble back on', () => {
  const storage = memoryStorage()
  assert.equal(isOutcomeBubbleMuted(storage), false)
  assert.equal(setOutcomeBubbleMuted(true, storage), true)
  assert.equal(isOutcomeBubbleMuted(storage), true)
  assert.equal(setOutcomeBubbleMuted(false, storage), true)
  assert.equal(isOutcomeBubbleMuted(storage), false)
  assert.equal(storage.values.has(OUTCOME_BUBBLE_STORAGE_KEY), false, 're-enabling removes the key instead of storing a second state')
})

test('unreadable or unwritable storage keeps asking and reports the failed save', () => {
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  assert.equal(isOutcomeBubbleMuted(broken), false)
  assert.equal(setOutcomeBubbleMuted(true, broken), false)
  assert.equal(setOutcomeBubbleMuted(true, null), false)
})
