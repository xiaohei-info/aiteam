import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  collapseOverlappingDirectories,
  dedupeScannedFiles,
  planLocalScanAfterDirectorySelect,
  planManualLocalScan,
  runLocalDirectoryScanBatch,
  writeLocalScanDirectoryCaches,
} from '../src/pages/KnowledgeBase/localKnowledgeStore.ts'

const indexSource = readFileSync(new URL('../src/pages/KnowledgeBase/index.tsx', import.meta.url), 'utf8')

test('选择本地目录后进入确认扫描弹窗环节，确认后才执行扫描，且工具栏仅保留“扫描”按钮', () => {
  assert.match(indexSource, /planLocalScanAfterDirectorySelect/)
  assert.match(indexSource, /setPendingScanPlan\(plan\)/)
  assert.match(indexSource, /id="kb-confirm-scan-title"/)
  assert.match(indexSource, /确认扫描本地目录？/)
  assert.match(indexSource, /确认重新扫描本地目录？/)
  assert.match(indexSource, /handleConfirmLocalScan/)
  assert.doesNotMatch(indexSource, /handleLocalScan/)
  const toolbarMatch = indexSource.match(/<div className="kb-local-scan-toolbar">[\s\S]*?<\/div>/)
  assert.ok(toolbarMatch)
  assert.equal((toolbarMatch[0].match(/<button\b/g) ?? []).length, 1)
  assert.match(toolbarMatch[0], /\s扫描\s*<\/button>/)
  assert.doesNotMatch(toolbarMatch[0], /\+ 扫描目录/)
})

test('已扫描目录存在时新增目录仅扫描新目录，避免重复扫描已扫描目录', () => {
  const plan = planLocalScanAfterDirectorySelect({
    selectedDirectories: ['/Users/demo/DocsB/', '/Users/demo/DocsA'],
    authorizedDirectories: ['/Users/demo/DocsA'],
    directoryCaches: [
      {
        directory: '/Users/demo/DocsA',
        files: [{ name: 'a.md', path: '/Users/demo/DocsA/a.md', size: 120 }],
        scannedAt: '2026-10-08T08:00:00.000Z',
      },
    ],
  })

  if (!plan) throw new Error('expected plan')
  assert.equal(plan.mode, 'new')
  assert.deepEqual(plan.directoriesToScan, ['/Users/demo/DocsB'])
  assert.deepEqual(plan.skippedDirectories, ['/Users/demo/DocsA'])
  assert.deepEqual(plan.nextAuthorizedDirectories, ['/Users/demo/DocsA', '/Users/demo/DocsB'])
})

test('同时选择父目录与子目录或带尾斜杠路径时自动合并，避免子目录被重复递归扫描', () => {
  assert.deepEqual(
    collapseOverlappingDirectories([
      '/Users/demo/Knowledge/',
      '/Users/demo/Knowledge/Sub',
      '/Users/demo/Knowledge',
      '/Users/demo/Other',
    ]),
    ['/Users/demo/Knowledge', '/Users/demo/Other'],
  )

  const plan = planLocalScanAfterDirectorySelect({
    selectedDirectories: ['/Users/demo/Knowledge', '/Users/demo/Knowledge/Sub'],
    authorizedDirectories: [],
    directoryCaches: [],
  })

  if (!plan) throw new Error('expected plan')
  assert.equal(plan.mode, 'new')
  assert.deepEqual(plan.directoriesToScan, ['/Users/demo/Knowledge'])
  assert.deepEqual(plan.skippedDirectories, ['/Users/demo/Knowledge/Sub'])
})

test('选择已扫描过的目录时提示重新扫描且只重扫所选目录，不连带重扫其他目录', () => {
  const plan = planLocalScanAfterDirectorySelect({
    selectedDirectories: ['/Users/demo/DocsB'],
    authorizedDirectories: ['/Users/demo/DocsA', '/Users/demo/DocsB'],
    directoryCaches: [
      {
        directory: '/Users/demo/DocsA',
        files: [{ name: 'a.md', path: '/Users/demo/DocsA/a.md', size: 100 }],
        scannedAt: '2026-10-08T08:00:00.000Z',
      },
      {
        directory: '/Users/demo/DocsB',
        files: [{ name: 'b.pdf', path: '/Users/demo/DocsB/b.pdf', size: 200 }],
        scannedAt: '2026-10-08T08:05:00.000Z',
      },
    ],
  })

  if (!plan) throw new Error('expected plan')
  assert.equal(plan.mode, 'rescan')
  assert.deepEqual(plan.directoriesToScan, ['/Users/demo/DocsB'])
})

test('手动点击扫描按钮时优先仅扫描未扫描目录；全部已扫描时仅重扫当前会话已授权目录', () => {
  const caches = [
    {
      directory: '/Users/demo/OldSessionDir',
      files: [{ name: 'old.docx', path: '/Users/demo/OldSessionDir/old.docx', size: 512 }],
      scannedAt: '2026-10-07T08:00:00.000Z',
    },
  ]

  const unscannedPlan = planManualLocalScan({
    authorizedDirectories: ['/Users/demo/OldSessionDir', '/Users/demo/NewDir'],
    directoryCaches: caches,
    sessionAuthorizedDirectories: ['/Users/demo/NewDir'],
  })
  if (!unscannedPlan) throw new Error('expected unscannedPlan')
  assert.equal(unscannedPlan.mode, 'new')
  assert.deepEqual(unscannedPlan.directoriesToScan, ['/Users/demo/NewDir'])
  assert.deepEqual(unscannedPlan.skippedDirectories, ['/Users/demo/OldSessionDir'])

  const rescanPlan = planManualLocalScan({
    authorizedDirectories: ['/Users/demo/OldSessionDir', '/Users/demo/NewDir'],
    directoryCaches: [
      ...caches,
      {
        directory: '/Users/demo/NewDir',
        files: [{ name: 'new.md', path: '/Users/demo/NewDir/new.md', size: 256 }],
        scannedAt: '2026-10-08T09:00:00.000Z',
      },
    ],
    sessionAuthorizedDirectories: ['/Users/demo/NewDir'],
  })
  if (!rescanPlan) throw new Error('expected rescanPlan')
  assert.equal(rescanPlan.mode, 'rescan')
  assert.deepEqual(rescanPlan.directoriesToScan, ['/Users/demo/NewDir'])
  assert.deepEqual(rescanPlan.skippedDirectories, ['/Users/demo/OldSessionDir'])
})

test('批量扫描逐目录容错：旧目录权限失效不会导致新选择的目录不扫描', async () => {
  const progressEvents: Array<{ completed: number; total: number; filesFound: number }> = []
  const result = await runLocalDirectoryScanBatch(
    ['/Users/demo/ExpiredDir', '/Users/demo/FreshDir'],
    async (directory) => {
      if (directory === '/Users/demo/ExpiredDir') {
        throw new Error('目录访问权限已失效：/Users/demo/ExpiredDir。请重新从系统选择器授权该目录后再扫描。')
      }
      return [
        { name: '知识手册.md', path: '/Users/demo/FreshDir/知识手册.md', size: 1024 },
        { name: '报告.pdf', path: '/Users/demo/FreshDir/报告.pdf', size: 2048 },
      ]
    },
    (progress) => {
      progressEvents.push({
        completed: progress.completed,
        total: progress.total,
        filesFound: progress.filesFound,
      })
    },
  )

  assert.equal(result.updates.length, 1)
  assert.equal(result.updates[0].directory, '/Users/demo/FreshDir')
  assert.equal(result.updates[0].files.length, 2)
  assert.equal(result.scannedFilesCount, 2)
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].directory, '/Users/demo/ExpiredDir')
  assert.equal(result.failed[0].permissionDenied, true)
  assert.deepEqual(progressEvents, [
    { completed: 1, total: 2, filesFound: 0 },
    { completed: 2, total: 2, filesFound: 2 },
  ])
})

test('所选目录的父路径包含隐藏目录名时不误删扫描文件，但仍过滤目录内部隐藏文件', () => {
  const rootDir = '/Users/demo/.work-cache/KnowledgeDocs'
  const files = dedupeScannedFiles(
    [
      { name: '方案.docx', path: `${rootDir}/方案.docx`, size: 4096 },
      { name: '隐藏说明.md', path: `${rootDir}/.git/隐藏说明.md`, size: 512 },
      { name: '.DS_Store', path: `${rootDir}/.DS_Store`, size: 128 },
    ],
    rootDir,
  )

  assert.deepEqual(files.map((item) => item.name), ['方案.docx'])
})

test('增量写入目录缓存保留已有目录结果并在扫描父目录时合并替换子目录缓存', async () => {
  await writeLocalScanDirectoryCaches([
    {
      directory: '/Users/demo/Docs/Sub',
      files: [{ name: 'old-sub.md', path: '/Users/demo/Docs/Sub/old-sub.md', size: 100 }],
    },
    {
      directory: '/Users/demo/Other',
      files: [{ name: 'other.pdf', path: '/Users/demo/Other/other.pdf', size: 200 }],
    },
  ])

  const merged = await writeLocalScanDirectoryCaches([
    {
      directory: '/Users/demo/Docs/',
      files: [{ name: 'root.md', path: '/Users/demo/Docs/root.md', size: 300 }],
    },
  ])

  assert.deepEqual(
    merged.directories?.map((item) => item.directory),
    ['/Users/demo/Docs', '/Users/demo/Other'],
  )
  assert.deepEqual(
    merged.files.map((item) => item.name),
    ['other.pdf', 'root.md'],
  )
})
