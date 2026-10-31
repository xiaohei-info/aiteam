import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginAttachmentUpload,
  completeAttachmentUpload,
  failAttachmentUpload,
  hasBlockingAttachmentUpload,
  removeAttachmentUpload,
  runWhenAttachmentsReady,
  uploadedAttachmentIds,
  uploadedMessageAttachments,
} from '../src/lib/chatAttachmentUpload.ts'
import { submitGroupPrompt } from '../src/lib/groupPrompt.ts'

const cachedFile = {
  rel_path: 'tenant/group/file/report.pdf',
  asset_url: 'asset://localhost/report.pdf',
  name: 'report.pdf',
  size: 2048,
  mime: 'application/pdf',
}

test('附件只有真实上传成功后才能生成 attachment id 和消息附件', () => {
  const uploading = beginAttachmentUpload(cachedFile, 'client-file-1')
  assert.equal(hasBlockingAttachmentUpload([uploading]), true)
  assert.deepEqual(uploadedAttachmentIds([uploading]), [])
  assert.deepEqual(uploadedMessageAttachments([uploading]), [])

  const uploaded = completeAttachmentUpload(uploading, 'attachment-1')
  assert.equal(hasBlockingAttachmentUpload([uploaded]), false)
  assert.deepEqual(uploadedAttachmentIds([uploaded]), ['attachment-1'])
  assert.deepEqual(uploadedMessageAttachments([uploaded]), [{
    id: 'attachment-1',
    filename: 'report.pdf',
    name: 'report.pdf',
    mime_type: 'application/pdf',
    byte_size: 2048,
    kind: 'file',
  }])
})

test('上传失败不产生伪附件，保留同一客户端 id 后可以重试', () => {
  const uploading = beginAttachmentUpload(cachedFile, 'client-file-1')
  const failed = failAttachmentUpload(uploading, 'network unavailable')

  assert.equal(failed.upload?.status, 'failed')
  assert.equal(failed.upload?.error, 'network unavailable')
  assert.equal(hasBlockingAttachmentUpload([failed]), true)
  assert.deepEqual(uploadedAttachmentIds([failed]), [])

  const retrying = beginAttachmentUpload(failed, failed.upload!.clientId)
  const uploaded = completeAttachmentUpload(retrying, 'attachment-after-retry')
  assert.equal(uploaded.upload?.clientId, 'client-file-1')
  assert.deepEqual(uploadedAttachmentIds([uploaded]), ['attachment-after-retry'])
})

test('取消附件会从待发送状态中彻底移除', () => {
  const uploading = beginAttachmentUpload(cachedFile, 'client-file-1')
  const remaining = removeAttachmentUpload([uploading], 'client-file-1')
  assert.deepEqual(remaining, [])
  assert.deepEqual(uploadedAttachmentIds(remaining), [])
})

test('键盘发送遇到上传中或失败附件时不会发送或清空输入', () => {
  const blockedFiles = [
    beginAttachmentUpload(cachedFile, 'uploading-file'),
    failAttachmentUpload(beginAttachmentUpload(cachedFile, 'failed-file'), 'upload failed'),
  ]

  for (const file of blockedFiles) {
    let didSend = false
    let didClear = false
    runWhenAttachmentsReady([file], true, () => {
      didClear = true
      didSend = true
    })
    assert.equal(didSend, false)
    assert.equal(didClear, false)
  }
})

test('群聊 prompt 提交去重后的 attachment_ids，并兼容 mentions', async () => {
  const calls: unknown[][] = []

  await submitGroupPrompt(
    { id: 'group-1' },
    '',
    ['reviewer', 'reviewer'],
    'idem-attachment-1',
    async (...args) => { calls.push(args) },
    ['attachment-1', 'attachment-1', '', 'attachment-2'],
  )

  assert.deepEqual(calls, [[
    'group-1',
    {
      text: '',
      mentions: ['reviewer'],
      attachment_ids: ['attachment-1', 'attachment-2'],
    },
    'idem-attachment-1',
  ]])
})
