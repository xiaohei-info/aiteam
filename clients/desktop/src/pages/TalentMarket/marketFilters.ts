import type { TalentFilters } from './TalentFilterSidebar'
import type { TalentSortKey } from './TalentSortSelect'
import type { MarketTemplate } from './types'

export const MARKET_PRICE_MIN = 0
export const MARKET_PRICE_MAX = 100

export function marketPriceOf(agent: MarketTemplate): number | null {
  return typeof agent.price_per_call === 'number' && Number.isFinite(agent.price_per_call)
    ? agent.price_per_call
    : null
}

export function hasAnyMarketFilter(filters: TalentFilters): boolean {
  return filters.categories.length > 0
    || filters.skills.length > 0
    || filters.levels.length > 0
    || filters.tags.length > 0
    || filters.priceMin > MARKET_PRICE_MIN
    || filters.priceMax < MARKET_PRICE_MAX
    || filters.outputTypes.length > 0
    || filters.pricingModes.length > 0
    || filters.noExternalSystems
}

function matchesFilters(agent: MarketTemplate, filters: TalentFilters): boolean {
  if (filters.categories.length && !filters.categories.includes(agent.category)) return false
  if (filters.skills.length && !agent.skills.some(skill => filters.skills.includes(skill))) return false
  if (filters.tags.length && !agent.tags.some(tag => filters.tags.includes(tag))) return false
  if (filters.levels.length && (!agent.level || !filters.levels.includes(agent.level))) return false
  if (filters.outputTypes.length && !agent.profile.output_types.some(type => filters.outputTypes.includes(type))) return false
  if (filters.pricingModes.length && (!agent.profile.pricing || !filters.pricingModes.includes(agent.profile.pricing.mode))) return false
  if (filters.noExternalSystems && agent.profile.required_connectors.length > 0) return false

  const price = marketPriceOf(agent)
  const priceFilterActive = filters.priceMin > MARKET_PRICE_MIN || filters.priceMax < MARKET_PRICE_MAX
  if (priceFilterActive && (price === null || price < filters.priceMin || price > filters.priceMax)) return false
  return true
}

function matchesSearch(agent: MarketTemplate, query: string): boolean {
  return [
    agent.name,
    agent.category,
    agent.description,
    agent.profile.tagline ?? '',
    ...agent.skills,
    ...agent.tags,
  ].join(' ').toLowerCase().includes(query)
}

export function filterMarketAgents(
  agents: readonly MarketTemplate[],
  filters: TalentFilters,
  query: string,
): MarketTemplate[] {
  const keyword = query.trim().toLowerCase()
  return agents.filter(agent => matchesFilters(agent, filters) && (!keyword || matchesSearch(agent, keyword)))
}

// 排序作用于全部可见结果，缺少真实数据（价格、解决率、更新时间）的始终排在已知数据之后。
export function sortMarketAgents(
  agents: readonly MarketTemplate[],
  sort: TalentSortKey,
): MarketTemplate[] {
  if (sort === 'composite') return [...agents]
  const sorted = [...agents]
  switch (sort) {
    case 'recruits':
      sorted.sort((a, b) => compareKnownDesc(a.recruit_count, b.recruit_count))
      break
    case 'price-asc':
      sorted.sort((a, b) => compareKnownPrices(a, b, (aPrice, bPrice) => aPrice - bPrice))
      break
    case 'price-desc':
      sorted.sort((a, b) => compareKnownPrices(a, b, (aPrice, bPrice) => bPrice - aPrice))
      break
    case 'resolution':
      // 样本不足（resolution_rate 为 null）的排在有解决率的后面。
      sorted.sort((a, b) => compareKnownDesc(a.profile.stats?.resolution_rate ?? null, b.profile.stats?.resolution_rate ?? null))
      break
    case 'updated':
      sorted.sort((a, b) => compareKnownDesc(updatedTime(a), updatedTime(b)))
      break
  }
  return sorted
}

function compareKnownDesc(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return b - a
}

function updatedTime(agent: MarketTemplate): number | null {
  const time = agent.profile.updated_at ? Date.parse(agent.profile.updated_at) : Number.NaN
  return Number.isFinite(time) ? time : null
}

function compareKnownPrices(
  a: MarketTemplate,
  b: MarketTemplate,
  compare: (aPrice: number, bPrice: number) => number,
): number {
  const aPrice = marketPriceOf(a)
  const bPrice = marketPriceOf(b)
  if (aPrice === null) return bPrice === null ? 0 : 1
  if (bPrice === null) return -1
  return compare(aPrice, bPrice)
}
