import type { ScannedKnowledgeFile } from '../pages/KnowledgeBase/types'

export const KNOWLEDGE_FILE_CATEGORIES = ['全部', '文档', '表格', '演示', '图片', '其他'] as const
export type KnowledgeFileCategory = typeof KNOWLEDGE_FILE_CATEGORIES[number]
export const KNOWLEDGE_FILE_PAGE_SIZE = 50
export interface IndexedKnowledgeFile {
  file: ScannedKnowledgeFile
  category: KnowledgeFileCategory
  searchName: string
}
export type KnowledgeFileIndex = Record<KnowledgeFileCategory, IndexedKnowledgeFile[]>
const extensionCategories: Record<string, KnowledgeFileCategory> = {
  txt: '文档', md: '文档', markdown: '文档', pdf: '文档', doc: '文档', docx: '文档', html: '文档', htm: '文档',
  csv: '表格', xlsx: '表格', xls: '表格', tsv: '表格', ppt: '演示', pptx: '演示',
  png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片', bmp: '图片', svg: '图片',
}

/** Classify and normalize once when the file snapshot changes, not on every render. */
export function buildKnowledgeFileIndex(files: ScannedKnowledgeFile[]): KnowledgeFileIndex {
  const index: KnowledgeFileIndex = { 全部: [], 文档: [], 表格: [], 演示: [], 图片: [], 其他: [] }
  for (const file of files) {
    const searchName = file.name.toLowerCase()
    const extension = searchName.includes('.') ? searchName.slice(searchName.lastIndexOf('.') + 1) : ''
    const category = Object.prototype.hasOwnProperty.call(extensionCategories, extension) ? extensionCategories[extension] : '其他'
    const entry = { file, category, searchName }
    index.全部.push(entry)
    index[category].push(entry)
  }
  return index
}

export function filterKnowledgeFiles(index: KnowledgeFileIndex, category: KnowledgeFileCategory, query: string): IndexedKnowledgeFile[] {
  const normalized = query.trim().toLowerCase()
  return normalized ? index[category].filter(entry => entry.searchName.includes(normalized)) : index[category]
}

export function paginateKnowledgeFiles(files: IndexedKnowledgeFile[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(files.length / KNOWLEDGE_FILE_PAGE_SIZE))
  const page = Math.min(Math.max(0, Math.trunc(requestedPage)), pageCount - 1)
  return { page, pageCount, files: files.slice(page * KNOWLEDGE_FILE_PAGE_SIZE, (page + 1) * KNOWLEDGE_FILE_PAGE_SIZE) }
}
