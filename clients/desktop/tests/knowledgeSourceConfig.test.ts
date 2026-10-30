import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGACY_NAS_ID } from '../src/pages/KnowledgeBase/knowledgeService.ts'
import {
  EMPTY_KNOWLEDGE_SOURCE_CONFIG,
  nasDisplayName,
  parseKnowledgeSourceConfig,
  upsertNasConnection,
} from '../src/pages/KnowledgeBase/knowledgeSourceConfig.ts'

test('the single NAS saved before multi-NAS becomes the first connection with the legacy id', () => {
  assert.deepEqual(
    parseKnowledgeSourceConfig({ enterpriseUrl: 'https://m.example.com', enterpriseToken: 't', localUrl: 'https://nas.example.com', localToken: 'n' }),
    { enterpriseUrl: 'https://m.example.com', enterpriseToken: 't', nas: [{ id: LEGACY_NAS_ID, name: '', url: 'https://nas.example.com', token: 'n' }] },
  )
  assert.deepEqual(parseKnowledgeSourceConfig({ enterpriseUrl: '', localUrl: '  ' }).nas, [])
  // Once saved as a list, legacy keys are ignored and broken entries are dropped.
  assert.deepEqual(
    parseKnowledgeSourceConfig({ localUrl: 'https://old.example.com', nas: [{ id: 'a', url: 'https://a.example.com' }, { id: '', url: 'https://b.example.com' }, null] }).nas,
    [{ id: 'a', name: '', url: 'https://a.example.com', token: '' }],
  )
  assert.deepEqual(parseKnowledgeSourceConfig(null), EMPTY_KNOWLEDGE_SOURCE_CONFIG)
})

test('adding a NAS rejects a repeated address or name; editing keeps the id', () => {
  const first = upsertNasConnection(EMPTY_KNOWLEDGE_SOURCE_CONFIG, { name: ' 总部 ', url: 'https://nas.example.com/', token: ' t ' })
  assert.match(first.id, /^nas-[0-9a-f]{8}$/)
  assert.deepEqual(first.config.nas, [{ id: first.id, name: '总部', url: 'https://nas.example.com', token: 't' }])
  assert.throws(() => upsertNasConnection(first.config, { name: '', url: 'HTTPS://NAS.example.com', token: '' }), /已连接为「总部」/)
  assert.throws(() => upsertNasConnection(first.config, { name: '总部', url: 'https://other.example.com', token: '' }), /已有名为「总部」/)

  const second = upsertNasConnection(first.config, { name: '', url: 'https://branch.example.com', token: '' })
  assert.notEqual(second.id, first.id)
  assert.equal(nasDisplayName(second.config.nas[1]), 'branch.example.com')

  // Editing fixes the same NAS, so its library keys and upload records stay valid.
  const edited = upsertNasConnection(second.config, { id: first.id, name: '上海总部', url: 'https://nas2.example.com', token: 'new' })
  assert.equal(edited.id, first.id)
  assert.deepEqual(edited.config.nas.map(item => [item.id, item.name]), [[first.id, '上海总部'], [second.id, '']])
  assert.doesNotThrow(() => upsertNasConnection(edited.config, { id: first.id, name: '上海总部', url: 'https://nas2.example.com', token: '' }))
  assert.throws(() => upsertNasConnection(edited.config, { id: 'gone', name: '', url: 'https://x.example.com', token: '' }), /已断开/)
})
