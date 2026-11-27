import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  areAttachmentsReady,
  attachmentKeys,
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

test('发送时记下附件位置，历史消息按会话与文件名找回', async () => {
  const { rememberAttachmentPaths, rememberedAttachmentPath } = await import('../src/lib/attachmentManifest.ts')
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } as Storage
  rememberAttachmentPaths('c1', [
    { id: 'path:/a/报价.pdf', filename: '报价.pdf', name: '报价.pdf', mime_type: 'application/pdf', path: '/a/报价.pdf' },
    { id: 'upload-1', filename: 'x.txt', name: 'x.txt', mime_type: 'text/plain' },
  ], storage)
  assert.equal(rememberedAttachmentPath('c1', '报价.pdf', storage), '/a/报价.pdf')
  assert.equal(rememberedAttachmentPath('c2', '报价.pdf', storage), undefined, '按会话隔离')
  assert.equal(rememberedAttachmentPath('c1', 'x.txt', storage), undefined, '上传的附件不记位置')
  rememberAttachmentPaths('c1', [{ id: 'path:/b/报价.pdf', filename: '报价.pdf', name: '报价.pdf', mime_type: 'application/pdf', path: '/b/报价.pdf' }], storage)
  assert.equal(rememberedAttachmentPath('c1', '报价.pdf', storage), '/b/报价.pdf', '同名以最近一次为准')
})

test('同一个文件再拖入 / 再选择不重复添加', () => {
  const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')
  assert.ok(bar.includes('!importingPathsRef.current.has(path) && !filesRef.current.some((file) => file.path === path)'), '已在附件区或正在添加的路径应跳过')
  assert.ok(bar.includes('onImportPath(path).finally(() => importingPathsRef.current.delete(path))'), '添加结束后释放占位，移除后可以再次添加')
})
