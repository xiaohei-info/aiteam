import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composerRestoreTarget } from '../src/lib/chatComposerRestore.ts'

const base = { mounted: true, sameConversation: true, composerEmpty: true, submittedConversationId: 'conv-1' }

test('failed send restores the composer in the same conversation', () => {
  assert.deepEqual(composerRestoreTarget(base), { kind: 'composer' })
})

test('failed send never overwrites text typed while the request was pending', () => {
  assert.deepEqual(composerRestoreTarget({ ...base, composerEmpty: false }), { kind: 'none' })
})

test('failed send after switching conversations goes back to the original draft', () => {
  assert.deepEqual(
    composerRestoreTarget({ ...base, sameConversation: false, composerEmpty: false }),
    { kind: 'draft', conversationId: 'conv-1' },
  )
})

test('failed send after leaving the chat page keeps the conversation draft', () => {
  assert.deepEqual(
    composerRestoreTarget({ ...base, mounted: false }),
    { kind: 'draft', conversationId: 'conv-1' },
  )
})

test('unmounted new-session composer leaves restoring to the page', () => {
  assert.deepEqual(
    composerRestoreTarget({ ...base, mounted: false, submittedConversationId: '' }),
    { kind: 'none' },
  )
})

test('composer clears before awaiting onSend', () => {
  const source = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  const send = source.slice(source.indexOf('const handleSend = async'))
  const clearAt = send.indexOf('clearComposer()')
  const awaitAt = send.indexOf('await onSend(')
  assert.ok(clearAt > 0 && awaitAt > clearAt, 'input must be cleared before the send request')
  const clearComposer = source.slice(source.indexOf('const clearComposer = '), source.indexOf('const readComposer = '))
  assert.ok(clearComposer.includes('composer.clear()') && clearComposer.includes('setFiles(() => [])'))
})

test('new session restores the draft only after a failed send', () => {
  const source = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const start = source.slice(source.indexOf('const startNewSession'), source.indexOf('const handleDraftChange'))
  assert.equal(start.indexOf('setConvDraft(conversation.id, trimmed, files)') > start.indexOf('await submitMessage('), true)
})

test('conversation drafts keep the @ mention tags, so switching back still submits mentions', () => {
  const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  assert.ok(
    bar.includes('onDraftTextChange(previousConvId, composer.valueRef.current.text, composer.snapshot())'),
    'leaving a conversation must store the mention snapshot next to the draft text',
  )
  assert.ok(
    bar.includes('composer.restore(nextDraft ? draftMentions : undefined, nextDraft)'),
    'switching conversations must restore the snapshot, not plain text',
  )
  assert.ok(bar.includes("composer.restore(draftMentions, draft ?? '')"), 'adopting a draft must restore the snapshot too')

  const store = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')
  assert.ok(store.includes('[convId]: { text, files, mentionSnapshot }'), 'the draft store must carry the snapshot')

  const group = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')
  assert.ok(group.includes('draftMentions={draftsByConv[activeGroupId]?.mentionSnapshot}'), '群聊页必须把快照传回输入框')
  assert.ok(group.includes('setConvDraft(convId, text, files, mentionSnapshot)'), '群聊页必须把快照写进草稿')
})
