import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('KnowledgeBase 页面不再注册全局 knowledge-scan-progress 事件监听', () => {
  const filePath = path.resolve(process.cwd(), 'src/pages/KnowledgeBase/index.tsx')
  const content = fs.readFileSync(filePath, 'utf-8')

  // 1. 不应再导入或调用 @tauri-apps/api/event 的 listen
  assert.ok(
    !content.includes("from '@tauri-apps/api/event'"),
    'KnowledgeBase/index.tsx 不应再从 @tauri-apps/api/event 导入 listen',
  )
  assert.ok(
    !content.includes("'knowledge-scan-progress'"),
    'KnowledgeBase/index.tsx 不应再硬编码订阅 knowledge-scan-progress 事件',
  )

  // 2. 误导性的报错文案应已被清理
  assert.ok(
    !content.includes('本地扫描进度监听不可用'),
    '“本地扫描进度监听不可用”报错文案已被移除，不再在进入页面时产生误报',
  )

  // 3. 扫描进度仍通过 runLocalDirectoryScanBatch 的回调驱动
  assert.ok(
    content.includes('runLocalDirectoryScanBatch'),
    '页面仍应调用 runLocalDirectoryScanBatch 驱动扫描',
  )
  assert.ok(
    content.includes('setLocalScanProgress'),
    '进度条仍应由 setLocalScanProgress 更新',
  )
})
