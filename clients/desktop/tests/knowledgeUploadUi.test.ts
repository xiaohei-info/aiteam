import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const detailSource = readFileSync(new URL('../src/pages/KnowledgeBase/Detail.tsx', import.meta.url), 'utf8')
const gridCardSource = readFileSync(new URL('../src/pages/KnowledgeBase/KbDocumentGridCard.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/pages/KnowledgeBase/KnowledgeBase.css', import.meta.url), 'utf8')

test('真实上传响应合并到文档列表后触发一次完成淡入', () => {
  assert.match(detailSource, /uploadedDocs\.map\(getKnowledgeFileMergeKey\)/)
  assert.match(detailSource, /recentlyUploadedFileKeys\.has\(getKnowledgeFileMergeKey\(file\)\)/)
  assert.match(gridCardSource, /justUploaded \? 'uploaded' : ''/)
  assert.match(styles, /@keyframes kb-document-upload-complete/)
})

test('上传区支持拖拽金色虚线反馈和键盘文件选择', () => {
  assert.match(detailSource, /onDragOver=\{handleDragOver\}/)
  assert.match(detailSource, /onDrop=\{handleDrop\}/)
  assert.match(detailSource, /role="button"/)
  assert.match(detailSource, /event\.key === 'Enter' \|\| event\.key === ' '/)
  assert.match(styles, /\.kb-dropzone[\s\S]*?border:\s*1px dashed rgba\(212, 175, 55/)
  assert.match(styles, /\.kb-tool-panel\.dragging \.kb-dropzone/)
})
