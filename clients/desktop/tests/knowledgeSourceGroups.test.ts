import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPersonalKnowledgeLevel,
  enterpriseDeploymentTag,
  knowledgeListEmptyText,
  misplacedPersonalLevel,
  personalLevelWarning,
  personalLevelWarningSummary,
  PERSONAL_KNOWLEDGE_LEVEL,
  PERSONAL_LEVEL_BLOCKED_MESSAGE,
  summarizeKnowledgeSources,
} from '../src/pages/KnowledgeBase/knowledgeSourceGroups.ts'
import type { KnowledgeSourceList } from '../src/api/agent/knowledgeSources.ts'
import type { KnowledgeBase } from '../src/pages/KnowledgeBase/types.ts'

const base = (patch: Partial<KnowledgeBase>): KnowledgeBase => ({ id: 'local:kb', icon: '▣', name: '销售资料', docCount: 0, updatedAt: '', files: [], source: 'local', ...patch })

test('personal services only accept the private level; team and enterprise are blocked before any request', () => {
  assert.equal(PERSONAL_KNOWLEDGE_LEVEL, 'private')
  assert.doesNotThrow(() => assertPersonalKnowledgeLevel('private'))
  for (const level of ['team', 'enterprise', '']) {
    assert.throws(() => assertPersonalKnowledgeLevel(level), { message: PERSONAL_LEVEL_BLOCKED_MESSAGE })
  }
})

test('only team or enterprise rows on a personal service are misplaced; enterprise libraries never are', () => {
  assert.equal(misplacedPersonalLevel(base({ level: 'team' })), 'team')
  assert.equal(misplacedPersonalLevel(base({ level: 'enterprise' })), 'enterprise')
  assert.equal(misplacedPersonalLevel(base({ level: 'private' })), null)
  assert.equal(misplacedPersonalLevel(base({ level: undefined })), null)
  assert.equal(misplacedPersonalLevel(base({ source: 'enterprise', level: 'enterprise' })), null)
})

test('migration hint names the library and service; the summary lists several libraries', () => {
  assert.equal(
    personalLevelWarning(base({ level: 'enterprise', sourceName: '家里 NAS' })),
    '「家里 NAS」上的「销售资料」标为企业级，但存放在个人服务上。个人服务只建议保存私人资料，企业资料请由管理员迁移到企业知识库。',
  )
  assert.match(personalLevelWarning(base({ level: 'team' })) ?? '', /^个人服务上的「销售资料」标为团队级/)
  assert.equal(personalLevelWarning(base({ level: 'private' })), null)

  assert.equal(personalLevelWarningSummary([base({ level: 'private' }), base({ source: 'enterprise', level: 'enterprise' })]), null)
  assert.equal(personalLevelWarningSummary([base({ level: 'team', sourceName: '家里 NAS' })]), personalLevelWarning(base({ level: 'team', sourceName: '家里 NAS' })))
  assert.equal(
    personalLevelWarningSummary([base({ level: 'team', name: '甲' }), base({ level: 'private', name: '乙' }), base({ level: 'enterprise', name: '丙' })]),
    '个人服务上有 2 个知识库标为团队级或企业级：「甲」、「丙」。个人服务只建议保存私人资料，企业资料请由管理员迁移到企业知识库。',
  )
})

test('source index groups enterprise and local items; deployment tags are deduplicated in a fixed order', () => {
  const list: KnowledgeSourceList = {
    data: [
      { source: 'enterprise', id: 's-1', name: '制度', deployment: 'nas', status: 'ready' },
      { source: 'enterprise', id: 's-2', name: '产品', deployment: 'managed', status: 'ready' },
      { source: 'enterprise', id: 's-3', name: '销售', deployment: 'nas', status: 'ready' },
      { source: 'local', id: 'd-1', name: '项目资料', deployment: 'this_device', status: 'ready' },
      { source: 'local', id: 'd-2', name: '合同', deployment: 'this_device', status: 'authorization_unavailable' },
    ],
    meta: { enterprise: 'ok', personal: 'client_held', local: 'ok' },
  }
  const summary = summarizeKnowledgeSources(list)
  assert.deepEqual(summary, {
    enterprise: { state: 'ready', count: 3, deployments: ['managed', 'nas'] },
    local: { state: 'ready', count: 2, unavailableCount: 1 },
  })
  assert.equal(enterpriseDeploymentTag(summary!.enterprise), '部署：Manager 托管 / 企业内网 NAS')
  assert.equal(enterpriseDeploymentTag({ state: 'ready', count: 1, deployments: ['nas'] }), '部署：企业内网 NAS')
  assert.equal(enterpriseDeploymentTag({ state: 'ready', count: 0, deployments: [] }), null)
  assert.equal(enterpriseDeploymentTag({ state: 'unavailable' }), null)
})

test('a Manager outage or missing local host only affects its own group', () => {
  const summary = summarizeKnowledgeSources({
    data: [{ source: 'local', id: 'd-1', name: '项目资料', deployment: 'this_device', status: 'ready' }],
    meta: { enterprise: 'unavailable', personal: 'client_held', local: 'ok' },
  })
  assert.deepEqual(summary?.enterprise, { state: 'unavailable' })
  assert.deepEqual(summary?.local, { state: 'ready', count: 1, unavailableCount: 0 })
  assert.deepEqual(summarizeKnowledgeSources({ data: [], meta: { enterprise: 'ok', personal: 'client_held', local: 'host_unavailable' } })?.local, { state: 'host_unavailable' })
})

test('an invalid index (older Agent, SPA fallback) falls back to the connection view', () => {
  assert.equal(summarizeKnowledgeSources(null), null)
  assert.equal(summarizeKnowledgeSources(undefined), null)
  assert.equal(summarizeKnowledgeSources('<!doctype html>' as unknown as KnowledgeSourceList), null)
  assert.equal(summarizeKnowledgeSources({ data: [] } as unknown as KnowledgeSourceList), null)
})

test('empty list text tells members the enterprise library exists even without a Manager connection', () => {
  const none = { index: null, connected: false }
  assert.match(knowledgeListEmptyText('all', none), /添加个人知识库服务/)
  assert.match(knowledgeListEmptyText('local', none), /仅本人可见/)
  assert.equal(knowledgeListEmptyText('enterprise', none), '连接企业知识库后，企业知识库会显示在这里。')
  assert.equal(
    knowledgeListEmptyText('enterprise', { index: { state: 'ready', count: 6, deployments: ['nas'] }, connected: false }),
    '管理员已为企业开通 6 个空间。连接企业知识库后，可以在这里浏览和上传文档。',
  )
  assert.match(knowledgeListEmptyText('enterprise', { index: { state: 'ready', count: 0, deployments: [] }, connected: true }), /联系管理员/)
  assert.equal(knowledgeListEmptyText('enterprise', { index: { state: 'unavailable' }, connected: true }), '企业知识库里还没有你可读的空间。')
})
