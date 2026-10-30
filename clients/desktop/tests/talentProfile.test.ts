import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connector } from '../src/api/agent/automationTasks.ts'
import type { MarketplaceTemplate } from '../src/api/agent/types.ts'
import {
  connectorStatuses,
  emptyTalentProfile,
  formatTemplatePricing,
  hasTalentRequirements,
  requiredPermissionLabels,
  solveRateSummary,
  solveRateTone,
  talentCardMetrics,
  talentReleaseLabel,
  talentTagline,
  toTalentProfile,
} from '../src/pages/TalentMarket/talentProfile.ts'

const legacyTemplate: MarketplaceTemplate = {
  template_id: 'legacy',
  display_name: '旧模板',
  category: 'research',
  model_name: '',
  skills_count: 2,
  recruit_count: null,
  is_recruited: false,
  tags: [],
  avatar_url: null,
}

const stats = (rate: number | null, evaluated = 30) => ({ resolution_rate: rate, evaluated_segments: evaluated, resolved_segments: 0, min_sample: 20 })

test('旧版 Agent 不返回展示字段时得到空画像，卡片按旧指标渲染', () => {
  assert.deepEqual(toTalentProfile(legacyTemplate), emptyTalentProfile())
  assert.deepEqual(
    talentCardMetrics({ profile: emptyTalentProfile(), recruit_count: null, skills_count: 2, model: 'DeepSeek' }).map(metric => metric.label),
    ['技能', '模型'],
  )
})

test('画像映射丢弃非法产出类型、非 http 链接和空白条目', () => {
  const profile = toTalentProfile({
    ...legacyTemplate,
    tagline: '  把零散数据整理成结论  ',
    use_cases: ['复盘', ' ', '复盘'],
    output_types: ['document', 'video' as never, 'document'],
    sample_outputs: [
      { title: '复盘报告', output_type: 'document', preview_url: 'javascript:alert(1)' },
      { title: '预算表', output_type: 'spreadsheet', preview_url: 'https://example.com/sheet' },
    ],
    changelog_url: 'data:text/html,x',
    platform_skill_refs: [
      { skill_id: 'uuid-1', version: '1', content_hash: 'h', display_name: '深度研究', summary: '检索资料并整理成报告' },
      { skill_id: 'uuid-2', version: '1', content_hash: 'h', display_name: null, summary: null },
    ],
  })

  assert.equal(profile.tagline, '把零散数据整理成结论')
  assert.deepEqual(profile.use_cases, ['复盘'])
  assert.deepEqual(profile.output_types, ['document'])
  assert.deepEqual(profile.sample_outputs.map(output => output.preview_url), [null, 'https://example.com/sheet'])
  assert.equal(profile.changelog_url, null)
  assert.deepEqual(profile.skill_details, [{ name: '深度研究', summary: '检索资料并整理成报告', version: '1' }])
})

test('卡片指标按 解决率 → 招募 → 计价 → 技能 → 模型 取前 3 个；样本不足的解决率不上卡片', () => {
  const pricing = { mode: 'per_call' as const, unit_price: '0.20', currency: 'USD' as const }
  const full = talentCardMetrics({ profile: { ...emptyTalentProfile(), stats: stats(0.86), pricing }, recruit_count: 312, skills_count: 4 })
  assert.deepEqual(full.map(metric => [metric.label, metric.value]), [['解决率', '86%'], ['招募', '312'], ['计价', '$0.2/次']])
  assert.equal(full[0].tone, 'success')

  const insufficient = talentCardMetrics({ profile: { ...emptyTalentProfile(), stats: stats(null, 4) }, recruit_count: 0, skills_count: 6, model: 'DeepSeek' })
  assert.deepEqual(insufficient.map(metric => [metric.label, metric.value]), [['招募', '0'], ['技能', '6 项'], ['模型', 'DeepSeek']])
})

test('解决率：样本不足显示「样本不足」，绝不显示 0%；色阶按 80% / 60% 分界', () => {
  assert.equal(solveRateSummary(stats(null, 4)), '样本不足（已评估 4 段，满 20 段后显示）')
  assert.equal(solveRateSummary(stats(0, 25)), '0%（已评估 25 段）')
  assert.equal(solveRateSummary(stats(0.745)), '75%（已评估 30 段）')
  assert.deepEqual([0.8, 0.79, 0.6, 0.59].map(solveRateTone), ['success', 'primary', 'primary', 'warning'])
})

test('计价按方式格式化，per_token 为每百万 Token 单价', () => {
  assert.equal(formatTemplatePricing({ mode: 'per_call', unit_price: '0.050', currency: 'USD' }), '$0.05/次')
  assert.equal(formatTemplatePricing({ mode: 'per_token', unit_price: '3', currency: 'USD' }), '$3/百万 Token')
  assert.equal(formatTemplatePricing({ mode: 'subscription', unit_price: '20', currency: 'USD' }), '$20 套餐')
})

test('一句话定位缺失时取描述前 40 字', () => {
  assert.equal(talentTagline('定位', '描述'), '定位')
  assert.equal(talentTagline(null, '短描述'), '短描述')
  assert.equal(talentTagline(null, '字'.repeat(41)), `${'字'.repeat(40)}…`)
})

test('外部系统按 ID 或展示名对照本机已启用连接器；读取失败时不判断', () => {
  const connectors: Connector[] = [
    { connector_id: 'feishu', display_name: '飞书', type: 'mcp', status: 'enabled', available_employee_ids: [] },
    { connector_id: 'github', display_name: 'GitHub', type: 'mcp', status: 'unavailable', available_employee_ids: [] },
  ]
  assert.deepEqual(connectorStatuses(['Feishu', 'github', '广告平台'], connectors), [
    { key: 'Feishu', name: '飞书', enabled: true },
    { key: 'github', name: 'github', enabled: false },
    { key: '广告平台', name: '广告平台', enabled: false },
  ])
  assert.deepEqual(connectorStatuses(['飞书'], null), [{ key: '飞书', name: '飞书', enabled: null }])
})

test('接入要求为空时可显示「无需额外配置」，权限只列出需要的项', () => {
  assert.equal(hasTalentRequirements(emptyTalentProfile()), false)
  assert.deepEqual(requiredPermissionLabels({ full_access: false, local_directories: false }), [])
  assert.deepEqual(requiredPermissionLabels({ full_access: true, local_directories: true }), ['需要允许完全访问', '需要授权本机目录'])
  assert.equal(hasTalentRequirements({ ...emptyTalentProfile(), required_permissions: { full_access: true, local_directories: false } }), true)
  assert.equal(hasTalentRequirements({ ...emptyTalentProfile(), recommended_knowledge: ['产品手册'] }), true)
})

test('发布信息只显示有数据的部分', () => {
  assert.equal(talentReleaseLabel({ version: null, updated_at: null }), '')
  assert.equal(talentReleaseLabel({ version: 'v1.4', updated_at: null }), 'v1.4')
  assert.equal(talentReleaseLabel({ version: '1.4', updated_at: '2026-10-21T12:00:00Z' }), 'v1.4 · 10/21 更新')
})
