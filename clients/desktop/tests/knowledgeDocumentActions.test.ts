import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  KNOWLEDGE_DOCUMENT_ACTION_AVAILABILITY,
  KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON,
  type KnowledgeDocumentAction,
} from '../src/pages/KnowledgeBase/documentActionAvailability.ts'

const REQUIRED_ACTIONS: readonly KnowledgeDocumentAction[] = [
  'select_multiple',
  'batch_move',
  'batch_delete',
  'batch_download',
  'rename',
  'delete',
]

test('knowledge document actions remain disabled until the server contract is complete', () => {
  assert.deepEqual(Object.keys(KNOWLEDGE_DOCUMENT_ACTION_AVAILABILITY), REQUIRED_ACTIONS)
  assert.match(KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON, /未开放知识文档管理/)
  for (const action of REQUIRED_ACTIONS) {
    const availability = KNOWLEDGE_DOCUMENT_ACTION_AVAILABILITY[action]
    assert.equal(availability.enabled, false)
    assert.equal(availability.reason, KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON)
  }

})

test('knowledge API exposes no fake document mutation or batch success path', () => {
  const apiSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/api.ts', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(apiSource, /export async function (?:rename|move|delete|batch)[A-Z][A-Za-z]+/)
  assert.match(apiSource, /knowledgeService\.listSource\(endpoint\)/)
  assert.match(apiSource, /knowledgeService\.upload\(kbId, file/)
  assert.doesNotMatch(apiSource, /requestAnyConfiguredSource/)
  assert.doesNotMatch(apiSource, /path: ['"]\/api\/agent\/knowledge-bases/)
})

test('knowledge detail does not present unsupported document actions as usable', () => {
  const detailSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/Detail.tsx', import.meta.url),
    'utf8',
  )
  const gridCardSource = readFileSync(
    new URL('../src/pages/KnowledgeBase/KbDocumentGridCard.tsx', import.meta.url),
    'utf8',
  )

  assert.match(detailSource, /KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON/)

  for (const unsupportedLabel of ['批量移动', '批量删除', '批量下载', '重命名文件', '删除文件']) {
    assert.doesNotMatch(detailSource, new RegExp(`>\\s*${unsupportedLabel}\\s*<`))
    assert.doesNotMatch(gridCardSource, new RegExp(`>\\s*${unsupportedLabel}\\s*<`))
  }
  assert.doesNotMatch(detailSource, /setList\([^)]*filter\([^)]*file\.id/)
})
