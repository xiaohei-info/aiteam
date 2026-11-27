import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginAttachmentImport,
  hasBlockingAttachmentUpload,
  isImportingAttachment,
  queueAttachmentUpload,
  runWhenAttachmentsReady,
} from '../src/lib/chatAttachmentUpload.ts'
import { clearSendErrorFor, sendErrorFor } from '../src/lib/conversationSendError.ts'

const copied = { rel_path: 't/c/big.mov', asset_url: 'asset://big', name: 'big.mov', size: 9, mime: 'video/quicktime' }

test('a file still being imported blocks sending, even without uploads', () => {
  const importing = beginAttachmentImport({ name: 'big.mov', mime: 'video/quicktime', size: 9 }, 'c1')
  assert.equal(importing.upload?.status, 'importing')
  assert.equal(importing.rel_path, '')
  assert.equal(isImportingAttachment([importing]), true)
  let sent = false
  assert.equal(runWhenAttachmentsReady([importing], false, () => { sent = true }), undefined)
  assert.equal(runWhenAttachmentsReady([importing], true, () => { sent = true }), undefined)
  assert.equal(sent, false, 'text must not go out without the file being imported')
})

test('a copy that finished in the background waits for upload and still blocks sending', () => {
  const queued = queueAttachmentUpload(copied, 'c1')
  assert.deepEqual(queued.upload, { clientId: 'c1', status: 'queued' })
  assert.equal(hasBlockingAttachmentUpload([queued]), true)
  assert.equal(isImportingAttachment([queued]), false)
})

test('send errors only show in the conversation they happened in', () => {
  const error = { conversationId: 'group-a', message: '发送失败，请重试。' }
  assert.equal(sendErrorFor(error, 'group-b'), null)
  assert.equal(sendErrorFor(error, 'group-a'), '发送失败，请重试。')
  assert.equal(clearSendErrorFor(error, 'group-b'), error, 'sending in B keeps A’s error')
  assert.equal(clearSendErrorFor(error, 'group-a'), null)
})

const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')

test('switching conversations keeps importing/uploading files in the old draft instead of cancelling them', () => {
  const effect = bar.slice(bar.indexOf('if (conversationChanged && !isConversationUpgrade)'), bar.indexOf('setKnowledgeOpen(false)'))
  assert.ok(effect.includes('const previousFiles = filesRef.current'))
  assert.ok(!effect.includes('cancelledUploadIdsRef'), 'switching must not cancel uploads')
  assert.ok(effect.includes('fileOwnersRef.current.set(file.upload.clientId, previousConvId)'))
})

test('a finished import/upload goes to its own conversation, never the one on screen', () => {
  const place = bar.slice(bar.indexOf('const placeFile = useCallback'), bar.indexOf('const handleUploadFile = useCallback'))
  assert.ok(place.includes('fileOwnersRef.current.get(clientId)'))
  assert.ok(place.includes('owner === prevConvRef.current'))
  assert.ok(place.includes('onDraftFileUpdate?.(owner, clientId, next)'))
  const upload = bar.slice(bar.indexOf('const handleUploadFile = useCallback'), bar.indexOf('const importInto = useCallback'))
  assert.ok(upload.includes('placeFile(clientId, completeAttachmentUpload('))
  assert.ok(upload.includes('placeFile(clientId, failAttachmentUpload('))
  assert.ok(!upload.includes('setPendingFiles((previous) => previous.map((item) =>\n          item.upload?.clientId === clientId ? completeAttachmentUpload'))
})

test('paste and drop show the import chip before copying', () => {
  const importInto = bar.slice(bar.indexOf('const importInto = useCallback'), bar.indexOf('const handlePickFile'))
  assert.ok(importInto.indexOf('beginAttachmentImport(') < importInto.indexOf('return load()'))
  assert.ok(bar.includes('() => onImportFile(file)'))
  assert.ok(bar.includes('() => onImportPath(path)'))
})

test('a failed send keeps the @ mentions in the draft it goes back to', () => {
  assert.ok(bar.includes("if (target.kind === 'draft') onDraftChange(target.conversationId, rawText, files, mentionSnapshot)"))
})

for (const page of ['Chat', 'GroupChat']) {
  test(`${page}: the send error is per conversation and wired to the draft-file updater`, () => {
    const source = readFileSync(new URL(`../src/pages/${page}/index.tsx`, import.meta.url), 'utf8')
    assert.ok(source.includes('useState<ConversationSendError | null>(null)'))
    assert.ok(!/setSendError\('/.test(source), 'errors must carry their conversation id')
    assert.ok(source.includes('onDraftFileUpdate={replaceDraftFile}'))
    assert.ok(!source.includes('setSendError(null) }, [active'), 'switching must not wipe another conversation’s error')
  })
}
