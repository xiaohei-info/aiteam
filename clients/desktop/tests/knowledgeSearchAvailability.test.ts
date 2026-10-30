import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY } from '../src/lib/knowledgeSearchAvailability.ts'

const apiSource = readFileSync(
  new URL('../src/pages/KnowledgeBase/api.ts', import.meta.url),
  'utf8',
)
const detailSource = readFileSync(
  new URL('../src/pages/KnowledgeBase/Detail.tsx', import.meta.url),
  'utf8',
)
const searchApiSource = apiSource.slice(
  apiSource.indexOf('export async function searchKnowledgeBase'),
  apiSource.indexOf('export async function updateEmployeeKnowledgeBases'),
)

test('knowledge full-text search remains unavailable until all result contracts exist', () => {
  assert.equal(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.enabled, false)
  assert.equal(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.status, 'gone')
  assert.match(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.reason, /410/)
  assert.match(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.reason, /摘要/)
  assert.match(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.reason, /高亮/)
  assert.match(KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY.reason, /定位/)
})

test('knowledge search API fails explicitly instead of producing local fake results', () => {
  assert.match(searchApiSource, /if \(endpoint\.source === 'enterprise'\) throw new Error/)
  assert.match(searchApiSource, /requestKnowledgeSource<unknown>\(endpoint,/)
  assert.doesNotMatch(searchApiSource, /requestAnyConfiguredSource/)
  assert.doesNotMatch(searchApiSource, /\.filter\(/)
})

test('document filter is labelled as filename-only and never presented as full-text search', () => {
  assert.match(detailSource, /placeholder="仅筛选文档名称"/)
  assert.match(detailSource, /aria-label="筛选文档名称（不搜索正文）"/)
  assert.match(detailSource, /KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY\.reason/)
  assert.doesNotMatch(detailSource, /import[^\n]*searchKnowledgeBase/)
})
