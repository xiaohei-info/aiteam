import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKnowledgeFileIndex, filterKnowledgeFiles, paginateKnowledgeFiles, KNOWLEDGE_FILE_CATEGORIES } from '../src/lib/knowledgeFilePicker.ts'

const file = (name: string) => ({ name, path: `/knowledge/${name}`, size: 100 })

test('分类索引处理大写扩展名、无扩展名和未知文件', () => {
  const index = buildKnowledgeFileIndex(['报告.PDF', '预算.XLSX', '方案.pptx', '照片.JPG', 'README', 'constructor', 'data.__proto__'].map(file))
  assert.equal(index.全部.length, 7)
  assert.equal(index.文档.length, 1)
  assert.equal(index.表格.length, 1)
  assert.equal(index.演示.length, 1)
  assert.equal(index.图片.length, 1)
  assert.equal(index.其他.length, 3)
  assert.deepEqual(filterKnowledgeFiles(index, '文档', ' 报告.pdf ').map(entry => entry.file.name), ['报告.PDF'])
})

test('一万个文件切换分类复用索引，分页最多渲染 50 项且末项可访问', () => {
  let reads = 0
  const files = Array.from({ length: 10001 }, (_, i) => ({
    get name() { reads++; return `${i}.pdf` }, path: `/knowledge/${i}.pdf`, size: 100,
  }))
  const index = buildKnowledgeFileIndex(files)
  assert.equal(reads, files.length)
  for (let i = 0; i < 10; i++) {
    for (const category of KNOWLEDGE_FILE_CATEGORIES) {
      const matches = filterKnowledgeFiles(index, category, '')
      assert.equal(matches, index[category])
      assert.ok(paginateKnowledgeFiles(matches, 0).files.length <= 50)
    }
  }
  assert.equal(reads, files.length, '切换分类不重新读取文件名或解析扩展名')
  const last = paginateKnowledgeFiles(index.全部, 999999)
  assert.equal(last.pageCount, 201)
  assert.equal(last.files.length, 1)
  assert.equal(last.files[0].file.path, '/knowledge/10000.pdf')
})

test('搜索或切换到小分类后越界页码安全回到有效页，空列表不产生负页码', () => {
  const index = buildKnowledgeFileIndex([file('report.pdf'), file('image.png')])
  assert.equal(paginateKnowledgeFiles(filterKnowledgeFiles(index, '图片', ''), 8).page, 0)
  const empty = paginateKnowledgeFiles(filterKnowledgeFiles(index, '全部', '不存在'), 8)
  assert.deepEqual(empty, { page: 0, pageCount: 1, files: [] })
})
