import assert from 'node:assert/strict'
import test from 'node:test'
import { getLastReadEntryId } from '../src/lib/readAnchor.ts'

test('会话已读锚点始终取最后一条真实 entry id', () => {
  assert.equal(getLastReadEntryId([{ id: 'entry-1' }, { id: 'entry-2' }]), 'entry-2')
})

test('entries 尚未加载或末条无有效 id 时不生成清空锚点', () => {
  assert.equal(getLastReadEntryId([]), null)
  assert.equal(getLastReadEntryId([{ id: 'entry-1' }, { id: '' }]), null)
  assert.equal(getLastReadEntryId([{ id: 'entry-1' }, {}]), null)
})
