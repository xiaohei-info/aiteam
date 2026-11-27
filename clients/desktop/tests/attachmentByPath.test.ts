import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  areAttachmentsReady,
  attachmentKeys,
  attachmentSendFailure,
  beginAttachmentImport,
  beginAttachmentUpload,
  completeAttachmentUpload,
  hasBlockingAttachmentUpload,
  isReferencedByPath,
  referenceAttachmentByPath,
  referencedAttachmentPaths,
  uploadedAttachmentIds,
  uploadedMessageAttachments,
} from '../src/lib/chatAttachmentUpload.ts'
import { buildSingleChatPrompt } from '../src/lib/singleChatPrompt.ts'
import { submitGroupPrompt } from '../src/lib/groupPrompt.ts'

// A 2 GB video dragged in from Finder: described where it is, never copied or uploaded.
const bigVideo = {
  rel_path: '',
  path: '/Users/me/Movies/发布会 录像.mov',
  asset_url: 'asset://localhost//Users/me/Movies/发布会 录像.mov',
  name: '发布会 录像.mov',
  size: 2 * 1024 * 1024 * 1024,
  mime: 'video/quicktime',
}
const uploadedPdf = completeAttachmentUpload(beginAttachmentUpload({ rel_path: 'u/c/file/a.pdf', asset_url: '', name: 'a.pdf', size: 10, mime: 'application/pdf' }, 'c2'), 'att-1')

test('按路径引用的附件立即可发送，不经过上传', () => {
  assert.equal(isReferencedByPath(bigVideo), true)
  assert.equal(isReferencedByPath({ ...bigVideo, path: '' }), false)
  const ready = referenceAttachmentByPath(bigVideo, 'c1')
  assert.deepEqual(ready.upload, { clientId: 'c1', status: 'uploaded' })
  assert.equal(hasBlockingAttachmentUpload([ready]), false)
  assert.deepEqual(uploadedAttachmentIds([ready]), [], 'no Agent-side copy, so no attachment ID')
  assert.deepEqual(referencedAttachmentPaths([ready, uploadedPdf]), [{ path: bigVideo.path, name: bigVideo.name }])
  assert.equal(areAttachmentsReady([ready, uploadedPdf]), true)
  assert.equal(areAttachmentsReady([ready, beginAttachmentImport({ name: 'x', mime: 'text/plain', size: 1 }, 'c3')]), false)
  assert.deepEqual(attachmentKeys([uploadedPdf, ready]), ['att-1', `path:${bigVideo.path}`])
  const [history] = uploadedMessageAttachments([ready])
  assert.equal(history?.path, bigVideo.path, 'history keeps the path so the file can be opened later')
  assert.equal(history?.byte_size, bigVideo.size)
})

test('单聊与群聊 prompt 同时携带 attachment_ids 与 attachment_paths', async () => {
  const ready = referenceAttachmentByPath(bigVideo, 'c1')
  assert.deepEqual(buildSingleChatPrompt('看看', [uploadedPdf, ready]), {
    text: '看看',
    attachment_ids: ['att-1'],
    attachment_paths: [{ path: bigVideo.path, name: bigVideo.name }],
  })
  const sent: unknown[] = []
  await submitGroupPrompt(
    { id: 'g1', members: [], coordinatorEmployeeId: 'e1' } as never,
    '看看',
    undefined,
    'k1',
    async (_id, prompt) => { sent.push(prompt) },
    [],
    referencedAttachmentPaths([ready]),
  )
  assert.deepEqual(sent, [{ text: '看看', attachment_paths: [{ path: bigVideo.path, name: bigVideo.name }] }])
})

test('拖入与选择文件走 describe_local_file（不复制），只有粘贴才写缓存', () => {
  for (const page of ['../src/pages/Chat/index.tsx', '../src/pages/GroupChat/index.tsx']) {
    const source = readFileSync(new URL(page, import.meta.url), 'utf8')
    assert.match(source, /\(path: string\) => describeLocalFile\(path\)/u, page)
    assert.doesNotMatch(source, /cacheFileFromPath/u, page)
  }
  const rust = readFileSync(new URL('../src-tauri/src/files.rs', import.meta.url), 'utf8')
  assert.match(rust, /pub fn describe_local_file\(/u)
  assert.match(readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'), /files::describe_local_file/u)
})

// History only has the list the Agent appended for the model; the bubble shows the user's text and file cards.
test('历史消息把附件清单显示为附件卡片，正文不出现编号清单', async () => {
  const { entriesToMessages } = await import('../src/lib/piConverters.ts')
  const text = '帮我看看\n\n[用户附件，可用 attachment_read 工具按编号读取]\n'
    + '- ref-1a2b：报价 单.pdf（PDF，12.0 MB）\n- ref-3c4d：截图.png（图片，800 KB，已随消息附上）\n- ref-5e6f：录屏.mov（视频，2.0 GB，无法读取内容）'
  const [message] = entriesToMessages([{ id: 'u1', type: 'message', message: { role: 'user', content: text } }] as never)
  assert.equal(message.content, '帮我看看')
  assert.deepEqual(message.attachments?.map((att) => [att.id, att.name, att.kind]), [
    ['ref-1a2b', '报价 单.pdf', 'file'], ['ref-3c4d', '截图.png', 'image'], ['ref-5e6f', '录屏.mov', 'file'],
  ])
  const [plain] = entriesToMessages([{ id: 'u2', type: 'message', message: { role: 'user', content: '正文里自己写了 [用户附件，可用 attachment_read 工具按编号读取]\n- 不是清单' } }] as never)
  assert.equal(plain.attachments, undefined, '不是 Agent 清单格式的正文原样保留')
  const [reply] = entriesToMessages([{ id: 'a1', type: 'message', message: { role: 'assistant', content: text } }] as never)
  assert.equal(reply.attachments, undefined, '只处理用户消息')
})

test('历史消息里的附件按 ref ID 定位，同名的两个文件各自打开各自那个', async () => {
  const { attachmentRefPath, forgetAttachmentRefPaths } = await import('../src/lib/attachmentRefPaths.ts')
  forgetAttachmentRefPaths()
  let calls = 0
  const refs = [
    { id: 'ref-1', path: '/a/报价.pdf' },
    { id: 'ref-2', path: '/b/报价.pdf' },
  ]
  const list = async (conversationId: string) => { calls += 1; return conversationId === 'c1' ? refs : [] }
  assert.equal(await attachmentRefPath('c1', 'ref-1', list), '/a/报价.pdf')
  assert.equal(await attachmentRefPath('c1', 'ref-2', list), '/b/报价.pdf', '同名不再串到最近一次')
  assert.equal(calls, 1, '同一会话只拉一次清单')
  assert.equal(await attachmentRefPath('c2', 'ref-1', list), undefined, '按会话隔离')
  refs.push({ id: 'ref-3', path: '/c/新的.pdf' })
  assert.equal(await attachmentRefPath('c1', 'ref-3', list), '/c/新的.pdf', '缓存没命中时重取一次')
})

test('同一个文件再拖入 / 再选择不重复添加', () => {
  const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  assert.ok(bar.includes("const key = (path: string) => path.normalize('NFC')"), '路径归一化后比较，访达的 NFD 与已有 NFC 算同一个')
  assert.ok(bar.includes('.filter((path) => !seen.has(key(path)))'), '已在附件区或正在添加的路径应跳过')
  assert.ok(bar.includes('onImportPath(path).finally(() => importingPathsRef.current.delete(key(path)))'), '添加结束后释放占位，移除后可以再次添加')
})

test('已上传附件：历史气泡不显示 Agent 拼入的附件文字，显示为附件卡片', async () => {
  const { entriesToMessages } = await import('../src/lib/piConverters.ts')
  const text = '总结一下\n\n[本地附件材料，仅来自当前会话已绑定文件]\n--- notes.md ---\n第一行\n--- 正文里的分隔 ---\n'
    + '\n\n[用户附件，可用 attachment_read 工具按编号读取]\n- 7f3c9e2a-1b4d-4c8e-9a0f-2d6b5e8c1a37：notes.md（文本，2.0 KB，已随消息附上）\n- ref-9a：big.txt（文本，12.0 MB）'
  const [message] = entriesToMessages([{ id: 'u1', type: 'message', message: { role: 'user', content: text } }] as never)
  assert.equal(message.content, '总结一下')
  assert.deepEqual(message.attachments?.map((att) => [att.id, att.name]), [
    ['7f3c9e2a-1b4d-4c8e-9a0f-2d6b5e8c1a37', 'notes.md'], ['ref-9a', 'big.txt'],
  ])
})

test('早于附件清单的历史消息：拼入的附件文字也不显示', async () => {
  const { entriesToMessages } = await import('../src/lib/piConverters.ts')
  const [message] = entriesToMessages([{ id: 'u1', type: 'message', message: { role: 'user', content: '看下\n\n[本地附件材料，仅来自当前会话已绑定文件]\n--- a.md ---\n内容' } }] as never)
  assert.equal(message.content, '看下')
})

test('附件被拒时说明原因和文件，并让用户移除后重发；其他错误不接管', () => {
  const reject = (code: string, message: string) => Object.assign(new Error(message), { code })
  assert.equal(
    attachmentSendFailure(reject('attachment_in_credential_folder', '为保护密钥与凭据，.ssh 目录里的文件不能作为附件：id_rsa')),
    '为保护密钥与凭据，.ssh 目录里的文件不能作为附件：id_rsa。请移除这个附件后重新发送。',
  )
  assert.equal(
    attachmentSendFailure(reject('attachment_has_hard_links', 'a.pdf 有多个硬链接，无法确认它真正指向哪个文件，不能作为附件。')),
    'a.pdf 有多个硬链接，无法确认它真正指向哪个文件，不能作为附件。请移除这个附件后重新发送。',
  )
  assert.equal(attachmentSendFailure(reject('attachment_not_found', '附件不存在：账单.pdf')), '附件不存在：账单.pdf。请移除这个附件后重新发送。')
  assert.equal(attachmentSendFailure(reject('attachment_not_found', '')), '有附件无法使用。请移除这个附件后重新发送。')
  assert.equal(attachmentSendFailure(reject('invalid_attachment_paths', 'Attachment path must be an absolute path')), '附件信息有误，请移除附件后重新发送。')
  assert.equal(attachmentSendFailure(reject('employee_not_runnable', 'x')), null)
  assert.equal(attachmentSendFailure(new Error('network')), null)
  assert.equal(attachmentSendFailure(null), null)
})

test('单聊、新会话、群聊发送失败都先用附件被拒的提示', () => {
  const chat = readFileSync(new URL('../src/pages/Chat/index.tsx', import.meta.url), 'utf8')
  const group = readFileSync(new URL('../src/pages/GroupChat/index.tsx', import.meta.url), 'utf8')
  assert.match(chat, /sendFailureRef\.current = attachmentSendFailure\(error\) \?\?/)
  assert.equal(chat.includes("message: '发送失败，请重试。' })"), false, '新会话页不再只给通用提示')
  assert.match(group, /message: attachmentSendFailure\(err\) \?\? employeeSendFailure\(err\)/)
})
