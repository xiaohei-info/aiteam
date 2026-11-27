import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { composerRestoreTarget } from '../src/lib/chatComposerRestore.ts'

const base = { mounted: true, sameConversation: true, composerTextEmpty: true, submittedConversationId: 'conv-1' }

test('failed send restores the composer in the same conversation', () => {
  assert.deepEqual(composerRestoreTarget(base), { kind: 'composer' })
})

test('failed send never overwrites text typed while the request was pending', () => {
  assert.deepEqual(composerRestoreTarget({ ...base, composerTextEmpty: false }), { kind: 'none' })
})

test('failed send after switching conversations goes back to the original draft', () => {
  assert.deepEqual(
    composerRestoreTarget({ ...base, sameConversation: false, composerTextEmpty: false }),
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
  const start = source.slice(source.indexOf('const startNewSession'), source.indexOf('const getDisplayContent'))
  // 放回草稿只发生在 submitMessage 失败之后，且与期间新加的附件合并（不覆盖）。
  assert.equal(start.indexOf('restoreFailedDraft(conversation.id, trimmed, files)') > start.indexOf('await submitMessage('), true)
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
  // 文字与附件各走一路：文字带快照写回草稿，附件由 updateDraftFiles 合并，发送成功只清文字。
  assert.ok(group.includes('onDraftTextChange={setConvDraftText}'), '群聊页必须把带快照的文字写进草稿')
  assert.ok(group.includes('onDraftFilesChange={updateDraftFiles}'), '群聊页的附件必须走唯一一份会话附件状态')
  const store2 = readFileSync(new URL('../src/stores/chat.ts', import.meta.url), 'utf8')
  assert.ok(store2.includes('setConvDraftText: (convId, text, mentionSnapshot) =>'), 'setConvDraftText 必须接受快照')
})
