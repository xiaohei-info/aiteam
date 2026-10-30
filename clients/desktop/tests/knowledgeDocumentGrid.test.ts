import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  KB_DOCUMENT_VIEW_MODE_STORAGE_KEY,
  readKnowledgeDocumentViewMode,
  writeKnowledgeDocumentViewMode,
} from '../src/pages/KnowledgeBase/viewModePreference.ts'

test('文档视图偏好使用账号无关 key，并安全读写合法模式', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }

  assert.equal(KB_DOCUMENT_VIEW_MODE_STORAGE_KEY, 'aifred:kb:documents:view-mode')
  assert.equal(readKnowledgeDocumentViewMode(storage), 'list')
  assert.equal(writeKnowledgeDocumentViewMode(storage, 'grid'), true)
  assert.equal(readKnowledgeDocumentViewMode(storage), 'grid')
  values.set(KB_DOCUMENT_VIEW_MODE_STORAGE_KEY, 'unsupported')
  assert.equal(readKnowledgeDocumentViewMode(storage), 'list')
})

test('文档视图偏好在 localStorage 不可用时降级为列表且不抛错', () => {
  const unavailableStorage = {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('storage denied') },
  }

  assert.equal(readKnowledgeDocumentViewMode(undefined), 'list')
  assert.equal(readKnowledgeDocumentViewMode(unavailableStorage), 'list')
  assert.equal(writeKnowledgeDocumentViewMode(unavailableStorage, 'grid'), false)
})

test('详情页网格和列表共用真实 KbFile、预览与现有重试操作', () => {
  const detailSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/Detail.tsx', import.meta.url),
    'utf8',
  )
  const cardSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/KbDocumentGridCard.tsx', import.meta.url),
    'utf8',
  )
  const cssSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/KnowledgeBase.css', import.meta.url),
    'utf8',
  )

  assert.match(detailSource, /documentViewMode === 'grid'/)
  assert.match(detailSource, /className="kb-doc-list detail-list"/)
  assert.match(detailSource, /pagedDocumentFiles\.map\(\(file\)/)
  assert.match(detailSource, /<KbDocumentGridCard/)
  assert.match(detailSource, /handleOpenDocumentPreview\(selectedFile\)/)
  assert.match(detailSource, /handleRetry\(selectedFile\)/)
  assert.doesNotMatch(detailSource, /from '\.\/data'/)

  assert.match(cardSource, /getKnowledgeFilePreviewUrlResult\(file\)/)
  assert.match(cardSource, /file\.uploadedAt/)
  assert.match(cardSource, /file\.status \|\| 'unknown'/)
  assert.match(cardSource, /isWriteDisabled \|\| isRetrying/)
  assert.doesNotMatch(cardSource, /删除|重命名|移动|下载|分享/)

  assert.match(cssSource, /\.kb-document-grid-card\s*\{[\s\S]*?width: 180px;[\s\S]*?height: 180px;/)
})
