import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginAttachmentImport,
  hasBlockingAttachmentUpload,
  importErrorMessage,
  isImportingAttachment,
  planAttachmentImports,
  queueAttachmentUpload,
  runWhenAttachmentsReady,
} from '../src/lib/chatAttachmentUpload.ts'
import { migrateDraftConversationId, withDraftFiles, withDraftText } from '../src/lib/chatDraftFiles.ts'
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

test('adding several files announces all of them before the first copy starts', () => {
  let next = 0
  const planned = planAttachmentImports([
    { name: '一.pdf', mime: 'application/pdf', size: 1 },
    { name: '二.pdf', mime: 'application/pdf', size: 2 },
    { name: '三.pdf', mime: 'application/pdf', size: 3 },
  ], () => `c${++next}`)
  assert.deepEqual(planned.map((entry) => entry.clientId), ['c1', 'c2', 'c3'], 'every file gets its own id up front')
  assert.deepEqual(planned.map((entry) => entry.placeholder.name), ['一.pdf', '二.pdf', '三.pdf'])
  assert.ok(planned.every((entry) => entry.placeholder.upload?.status === 'importing'))
  assert.equal(isImportingAttachment(planned.map((entry) => entry.placeholder)), true, '全部占位都挡住发送')
})

test('attachments of a conversation are one copy, changed only through withDraftFiles', () => {
  const importing = beginAttachmentImport({ name: 'big.mov', mime: 'video/quicktime', size: 9 }, 'c1')
  const first = withDraftFiles({}, 'conv-a', (files) => [...files, importing])
  assert.deepEqual(first.files, [importing])
  assert.equal(first.drafts['conv-a'].text, '', 'adding an attachment must not invent draft text')
  const done = withDraftFiles(first.drafts, 'conv-a', (files) =>
    files.map((file) => (file as typeof importing).upload?.clientId === 'c1' ? queueAttachmentUpload(copied, 'c1') : file))
  assert.equal((done.files[0] as typeof importing).upload?.status, 'queued', 'the finished copy replaces its own chip')
  // Saving the text on a conversation switch leaves the in-flight attachment where it is.
  const afterSwitch = withDraftText(done.drafts, 'conv-a', '半句话')
  assert.deepEqual(afterSwitch['conv-a'].files, done.files)
  assert.equal(afterSwitch['conv-a'].text, '半句话')
  // An attachment removed while its upload was running is not resurrected by the finishing upload.
  const removed = withDraftFiles(afterSwitch, 'conv-a', (files) => files.filter(() => false))
  const late = withDraftFiles(removed.drafts, 'conv-a', (files) =>
    files.some((file) => (file as typeof importing).upload?.clientId === 'c1') ? [copied] : files)
  assert.deepEqual(late.files, [], 'nothing holds it any more')
})

test('emp_ becoming a real conversation moves the draft, attachments included', () => {
  const importing = beginAttachmentImport({ name: 'big.mov', mime: 'video/quicktime', size: 9 }, 'c1')
  const drafts = withDraftFiles({ emp_1: { text: '看这个', files: [] } }, 'emp_1', (files) => [...files, importing]).drafts
  const moved = migrateDraftConversationId(drafts, 'emp_1', 'conv-real')
  assert.equal(moved.emp_1, undefined)
  assert.deepEqual(moved['conv-real'].files, [importing])
  assert.equal(moved['conv-real'].text, '看这个')
  assert.equal(migrateDraftConversationId({}, 'emp_1', 'conv-real')['conv-real'], undefined, 'nothing to move is a no-op')
})

test('send errors only show in the conversation they happened in', () => {
  const error = { conversationId: 'group-a', message: '发送失败，请重试。' }
  assert.equal(sendErrorFor(error, 'group-b'), null)
  assert.equal(sendErrorFor(error, 'group-a'), '发送失败，请重试。')
  assert.equal(clearSendErrorFor(error, 'group-b'), error, 'sending in B keeps A’s error')
  assert.equal(clearSendErrorFor(error, 'group-a'), null)
})

const bar = readFileSync(new URL('../src/components/Chat/ChatInputBar.tsx', import.meta.url), 'utf8')

test('the input box keeps no second copy of the attachment state', () => {
  assert.ok(!bar.includes('setPendingFiles'), '附件状态按会话只存一份，不再有本地副本')
  assert.ok(bar.includes('const pendingFiles = useMemo(() => (draftFiles ?? []) as UploadableChatFile[], [draftFiles])'))
  const setFiles = bar.slice(bar.indexOf('const setFiles = useCallback'), bar.indexOf('const handleCloseRolePicker'))
  assert.ok(setFiles.includes('onDraftFilesChange(target, update)'), '所有改动都写回该会话的唯一一份状态')
})

test('switching conversations saves only the text; in-flight attachments stay in their conversation', () => {
  const effect = bar.slice(bar.indexOf('if (conversationChanged && !isConversationUpgrade)'), bar.indexOf('if (isConversationUpgrade && submittingConvRef'))
  assert.ok(effect.includes('onDraftTextChange(previousConvId, composer.valueRef.current.text, composer.snapshot())'))
  assert.ok(!effect.includes('cancelledUploadIdsRef'), 'switching must not cancel uploads')
  assert.ok(!effect.includes('onDraftChange('), '附件不再随切换整份改写，避免把别的会话的附件写进来')
})

test('a finished import/upload goes to its own conversation, never the one on screen', () => {
  const place = bar.slice(bar.indexOf('const placeFile = useCallback'), bar.indexOf('const handleUploadFile = useCallback'))
  assert.ok(place.includes('fileOwnersRef.current.get(clientId)'))
  assert.ok(place.includes('}, owner)'), 'the change goes to the owning conversation')
  assert.ok(!place.includes('mountedRef.current'), '输入框开着还是关着都落到同一份状态')
  const upload = bar.slice(bar.indexOf('const handleUploadFile = useCallback'), bar.indexOf('const runImport = useCallback'))
  assert.ok(upload.includes('placeFile(clientId, completeAttachmentUpload('))
  assert.ok(upload.includes('placeFile(clientId, failAttachmentUpload('))
})

test('a whole batch of added files is pinned to the conversation it was added to before any copy starts', () => {
  const start = bar.slice(bar.indexOf('const startImports = useCallback'), bar.indexOf('}, [runImport, setFiles])'))
  const pinned = start.indexOf('const owner = prevConvRef.current')
  const planned = start.indexOf('planAttachmentImports(')
  const owners = start.indexOf('fileOwnersRef.current.set(clientId, owner)')
  const chips = start.indexOf('setFiles((previous) => [...previous, ...planned.map((entry) => entry.placeholder)], owner)')
  const firstCopy = start.indexOf('await runImport(')
  assert.ok(pinned >= 0 && planned > pinned && owners > planned && chips > owners && firstCopy > chips,
    '先固定归属、建全部占位，再逐个导入')
  assert.ok(!start.includes('prevConvRef.current)\n', owners), 'later files must not re-read the conversation on screen')
})

test('paste, drop and the「+」picker hand the whole list to the same batch import', () => {
  const paste = bar.slice(bar.indexOf('const handleImportFiles = useCallback'), bar.indexOf('const handleRemoveFile'))
  assert.ok(paste.includes('startImports(files.map('), '一次粘贴的多个文件整批交出去')
  assert.ok(!paste.includes('for (const file of files)'), '不再逐个 await，避免第二个文件落到切换后的会话')
  const drop = bar.slice(bar.indexOf('importPathsRef.current = (paths: string[])'), bar.indexOf('useEffect(() => {\n    if (!canDropFiles) return'))
  assert.ok(drop.includes('startImports(fresh.map('), '去重后的整批路径一次交给 startImports')
  assert.ok(drop.includes('importingPathsRef.current.delete(key(path))'), '同一路径（归一化后）导入中不重复添加')
  const pick = bar.slice(bar.indexOf('const handlePickFile = async'), bar.indexOf('const handleImportFiles'))
  assert.ok(pick.includes('path = await onPickFile()'))
  assert.ok(pick.includes('importPathsRef.current([path])'))
  assert.ok(!pick.includes('handleUploadFile('), 'picked files must not skip the import chip / ownership handling')
  const cache = readFileSync(new URL('../src/lib/fileCache.ts', import.meta.url), 'utf8')
  assert.ok(cache.includes('export async function pickFilePath(): Promise<string | null>'))
  assert.ok(!cache.includes('pickAndCacheFile'))
})

test('a failed send keeps the @ mentions in the draft it goes back to, and merges the attachments added meanwhile', () => {
  assert.ok(bar.includes('onDraftTextChange(target.conversationId, rawText, mentionSnapshot)'))
  assert.ok(bar.includes('onDraftFilesChange(target.conversationId, (current) => mergeDraftFiles(files, current))'),
    '放回的附件与发送期间新加的合并，不覆盖')
  assert.ok(bar.includes('if (target.kind === \'composer\') setFiles((current) => mergeDraftFiles(files, current))'))
})

for (const page of ['Chat', 'GroupChat']) {
  test(`${page}: the send error is per conversation and the attachments are stored per conversation`, () => {
    const source = readFileSync(new URL(`../src/pages/${page}/index.tsx`, import.meta.url), 'utf8')
    assert.ok(source.includes('useState<ConversationSendError | null>(null)'))
    assert.ok(!/setSendError\('/.test(source), 'errors must carry their conversation id')
    assert.ok(source.includes('onDraftFilesChange={updateDraftFiles}'))
    assert.ok(source.includes('onDraftTextChange={setConvDraftText}'))
    assert.ok(!source.includes('onDraftFileUpdate'), '附件状态只有一份，不再单独补写草稿附件')
    assert.ok(!source.includes('setSendError(null) }, [active'), 'switching must not wipe another conversation’s error')
  })
}

test('a file that failed to be added says why, since a retry cannot fix a size limit', () => {
  assert.equal(importErrorMessage('big.mov', 'File is larger than 64 MB'), '“big.mov”超过 64 MB 上限，无法添加')
  assert.equal(importErrorMessage('big.mov', new Error('Local file exceeds maximum size')), '“big.mov”超过 5 MB 上限，无法添加')
  assert.equal(importErrorMessage('文稿', 'Not a regular file'), '“文稿”是文件夹，不能作为附件；请拖入文件')
  assert.equal(importErrorMessage('a.txt', 'disk full'), '添加“a.txt”失败：disk full')
  assert.equal(importErrorMessage('a.txt', undefined), '添加“a.txt”失败，请重试')
})

test('paste and drop show the real reason instead of a bare retry line', () => {
  assert.ok(bar.includes('failure: (error: unknown) => importErrorMessage(name, error)'))
  assert.ok(!bar.includes('`添加“${name}”失败，请重试`'), '文案只在 importErrorMessage 里决定')
})

test('a file copied in Finder/Explorer is pasted by path, the same route as a dropped file', () => {
  const input = readFileSync(new URL('../src/components/Chat/MentionInput.tsx', import.meta.url), 'utf8')
  const cache = readFileSync(new URL('../src/lib/fileCache.ts', import.meta.url), 'utf8')
  assert.ok(cache.includes("invoke<string[]>('read_clipboard_file_paths')"))
  assert.ok(input.includes('void readClipboardFilePaths().then((paths) => {'))
  assert.ok(input.includes('onPaths(paths)') && input.includes('if (isJustFileNames(plain, paths)) return'),
    'copied files are imported by path, and text pasted alongside them is kept unless it is just their names')
  assert.ok(bar.includes('onPaths={canDropFiles ? handlePastePaths : undefined}'))
  assert.ok(bar.includes('const handlePastePaths = useCallback((paths: string[]) => importPathsRef.current(paths), [])'),
    'paste and drop share importPathsRef (dedupe, importing chip, error text)')
})
