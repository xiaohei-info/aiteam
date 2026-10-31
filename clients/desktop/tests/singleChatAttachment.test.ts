import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginAttachmentUpload,
  completeAttachmentUpload,
} from '../src/lib/chatAttachmentUpload.ts'
import {
  buildSingleChatPrompt,
  submitSingleChatPrompt,
} from '../src/lib/singleChatPrompt.ts'

const cachedFile = {
  rel_path: 'tenant/chat/file/report.pdf',
  asset_url: 'asset://localhost/report.pdf',
  name: 'report.pdf',
  size: 2048,
  mime: 'application/pdf',
}

test('单聊 prompt 只接受全部真实上传成功的附件', async () => {
  const uploading = beginAttachmentUpload(cachedFile, 'client-file-1')
  assert.throws(
    () => buildSingleChatPrompt('请分析', [uploading]),
    /附件尚未全部上传成功/,
  )

  const uploaded = completeAttachmentUpload(uploading, 'attachment-1')
  const calls: unknown[][] = []
  await submitSingleChatPrompt(
    'conversation-1',
    '请分析',
    [uploaded],
    'idem-1',
    async (...args) => { calls.push(args) },
  )
  assert.deepEqual(calls, [[
    'conversation-1',
    { text: '请分析', attachment_ids: ['attachment-1'] },
    'idem-1',
  ]])
})

test('单聊 submitPrompt 失败会原样向页面层传播', async () => {
  const uploaded = completeAttachmentUpload(
    beginAttachmentUpload(cachedFile, 'client-file-1'),
    'attachment-1',
  )
  await assert.rejects(
    submitSingleChatPrompt(
      'conversation-1',
      '请分析',
      [uploaded],
      'idem-1',
      async () => { throw new Error('network unavailable') },
    ),
    /network unavailable/,
  )
})

test('乐观消息不会被本地定时器伪造为 sent', () => {
  const senderSource = readFileSync(new URL('../src/lib/messageSender.ts', import.meta.url), 'utf8')
  const dispatchSource = senderSource.slice(
    senderSource.indexOf('function dispatch'),
    senderSource.indexOf('// ── Public send methods'),
  )
  assert.doesNotMatch(dispatchSource, /setTimeout/)
  assert.doesNotMatch(dispatchSource, /updateMessageStatus/)
})

test('单聊接入上传删除回调，点击发送立即清空编辑器、失败时放回', () => {
  const chatSource = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const inputSource = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')

  assert.match(chatSource, /onUploadFile=\{handleUploadFile\}/)
  assert.match(chatSource, /onDeleteUploadedFile=\{handleDeleteUploadedFile\}/)
  assert.match(chatSource, /await submitSingleChatPrompt\(/)
  assert.doesNotMatch(chatSource, /for \(const f of files\)/)
  assert.match(inputSource, /sent = await onSend\(/)
  assert.match(inputSource, /const target = sent \? \{ kind: 'none' as const \} : composerRestoreTarget\(/)
  assert.match(inputSource, /setPendingFiles\(files\)/)
})
