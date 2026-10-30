import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MARKET_PRICE_MAX,
  MARKET_PRICE_MIN,
  filterMarketAgents,
  hasAnyMarketFilter,
  sortMarketAgents,
} from '../src/pages/TalentMarket/marketFilters.ts'
import type { TalentFilters } from '../src/pages/TalentMarket/TalentFilterSidebar.tsx'
import { emptyTalentProfile, type TalentProfile } from '../src/pages/TalentMarket/talentProfile.ts'
import type { MarketTemplate } from '../src/pages/TalentMarket/types.ts'

const makeAgent = (
  templateId: string,
  overrides: Partial<MarketTemplate> = {},
): MarketTemplate => ({
  template_id: templateId,
  name: templateId,
  category: '研发',
  description: '',
  skills: [],
  skills_count: 0,
  tags: [],
  recruit_count: 0,
  is_recruited: false,
  profile: emptyTalentProfile(),
  ...overrides,
})

const withProfile = (overrides: Partial<TalentProfile>): TalentProfile => ({ ...emptyTalentProfile(), ...overrides })

const emptyFilters = (): TalentFilters => ({
  categories: [],
  skills: [],
  levels: [],
  tags: [],
  priceMin: MARKET_PRICE_MIN,
  priceMax: MARKET_PRICE_MAX,
  outputTypes: [],
  pricingModes: [],
  noExternalSystems: false,
})

test('人才筛选维度之间取 AND、同维选项取 OR，并与搜索词共同生效', () => {
  const agents = [
    makeAgent('frontend', {
      name: '前端工程师', skills: ['TypeScript', 'React'], tags: ['Web'], level: 'L3', price_per_call: 40,
    }),
    makeAgent('backend', {
      name: '后端工程师', skills: ['Go'], tags: ['API'], level: 'L3', price_per_call: 50,
    }),
    makeAgent('writer', {
      name: '技术作者', category: '内容', description: 'TypeScript 教程', tags: ['文档'], level: 'L2', price_per_call: 30,
    }),
  ]
  const filters: TalentFilters = {
    ...emptyFilters(),
    categories: ['研发', '内容'],
    skills: ['TypeScript', 'Go'],
    levels: ['L3'],
    priceMin: 35,
    priceMax: 55,
  }

  assert.equal(hasAnyMarketFilter(filters), true)
  assert.deepEqual(filterMarketAgents(agents, filters, '前端').map(agent => agent.template_id), ['frontend'])
  assert.deepEqual(filterMarketAgents(agents, filters, '').map(agent => agent.template_id), ['frontend', 'backend'])
})

test('价格筛选激活时缺失真实价格的模板不会伪造命中', () => {
  const agents = [
    makeAgent('known', { price_per_call: 20 }),
    makeAgent('unknown'),
  ]
  const filters = { ...emptyFilters(), priceMax: 30 }

  assert.deepEqual(filterMarketAgents(agents, filters, '').map(agent => agent.template_id), ['known'])
})

test('已招募次数和价格排序不修改输入，未知价格在升降序中都置后', () => {
  const agents = [
    makeAgent('unknown', { recruit_count: 5 }),
    makeAgent('cheap', { price_per_call: 10, recruit_count: 2 }),
    makeAgent('expensive', { price_per_call: 80, recruit_count: 9 }),
  ]
  const originalOrder = agents.map(agent => agent.template_id)

  assert.deepEqual(sortMarketAgents(agents, 'recruits').map(agent => agent.template_id), ['expensive', 'unknown', 'cheap'])
  assert.deepEqual(sortMarketAgents(agents, 'price-asc').map(agent => agent.template_id), ['cheap', 'expensive', 'unknown'])
  assert.deepEqual(sortMarketAgents(agents, 'price-desc').map(agent => agent.template_id), ['expensive', 'cheap', 'unknown'])
  assert.deepEqual(agents.map(agent => agent.template_id), originalOrder)
})

test('产出类型、计价方式、无需外部系统筛选只按服务端字段命中，旧模板不伪造命中', () => {
  const agents = [
    makeAgent('report', { profile: withProfile({ output_types: ['document', 'spreadsheet'], pricing: { mode: 'per_call', unit_price: '0.2', currency: 'USD' } }) }),
    makeAgent('ads', { profile: withProfile({ output_types: ['document'], required_connectors: ['ad-platform'] }) }),
    makeAgent('legacy'),
  ]

  assert.equal(hasAnyMarketFilter({ ...emptyFilters(), noExternalSystems: true }), true)
  assert.deepEqual(filterMarketAgents(agents, { ...emptyFilters(), outputTypes: ['spreadsheet'] }, '').map(agent => agent.template_id), ['report'])
  assert.deepEqual(filterMarketAgents(agents, { ...emptyFilters(), pricingModes: ['per_call'] }, '').map(agent => agent.template_id), ['report'])
  assert.deepEqual(filterMarketAgents(agents, { ...emptyFilters(), noExternalSystems: true }, '').map(agent => agent.template_id), ['report', 'legacy'])
})

test('解决率和最近更新排序把样本不足、无更新时间的模板排后', () => {
  const stats = (rate: number | null) => ({ resolution_rate: rate, evaluated_segments: 30, resolved_segments: 20, min_sample: 20 })
  const agents = [
    makeAgent('few', { profile: withProfile({ stats: stats(null), updated_at: '2026-10-01T00:00:00Z' }) }),
    makeAgent('low', { profile: withProfile({ stats: stats(0.58) }) }),
    makeAgent('high', { profile: withProfile({ stats: stats(0.86), updated_at: '2026-10-21T00:00:00Z' }) }),
  ]

  assert.deepEqual(sortMarketAgents(agents, 'resolution').map(agent => agent.template_id), ['high', 'low', 'few'])
  assert.deepEqual(sortMarketAgents(agents, 'updated').map(agent => agent.template_id), ['high', 'few', 'low'])
})
