// 后台提供文档中的人才目录；市场关键词与分类仅在客户端过滤。
import { AgentApiError } from '../../api/agent'
import { backendApi } from '../../api/backend'
import type { MarketplaceTemplate } from '../../api/agent/types'
import { toTalentProfile } from './talentProfile'
import type {
  MarketCategory,
  MarketListResponse,
  MarketTemplate,
  MarketTemplateDetail,
  RecruitResponse,
} from './types'

interface MarketQuery {
  tag?: string
  q?: string
  page?: number
  pageSize?: number
}

interface MarketRequestOptions {
  force?: boolean
}

const ALL_CATEGORY: MarketCategory = { id: 'all', label: '全部' }

const marketListRequests = new Map<string, Promise<MarketListResponse>>()

// 旧栈的 normalizeMarketTemplate / normalizeMarketDetail 及一大堆 read*/asRecord helper
// 都是围绕 Hermes 松散字段设计的,新栈 MarketplaceTemplate 由 TypeBox 严格 schema 保证类型,
// 直接用 marketplaceToLocal / marketplaceToDetail 转换即可,不再需要这些防御式读取器。

export function deriveMarketCategories(agents: MarketTemplate[]): MarketCategory[] {
  const counts = new Map<string, number>()

  for (const agent of agents) {
    if (!agent.category || agent.category === ALL_CATEGORY.id) continue
    counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1)
  }

  const categoryTabs = Array.from(counts.entries())
    .map(([id, count]) => ({
      id,
      label: id,
      count,
    }))

  return [
    { ...ALL_CATEGORY, count: agents.length },
    ...categoryTabs,
  ]
}

// 将 FredServer MarketplaceTemplate 转换为前端 MarketTemplate。
// 服务端未提供的字段保持为空，由 UI 整行隐藏，不生成业务数据。
function marketplaceToLocal(m: MarketplaceTemplate): MarketTemplate {
  const category = m.category || ''
  // 未完成统计的模板可能返回 null；保留缺失态，不能用 0 冒充真实招募次数。
  const recruitCount = typeof m.recruit_count === 'number' && Number.isFinite(m.recruit_count)
    ? m.recruit_count
    : null
  const skillsCount = m.platform_skill_refs?.length ?? m.skills_count ?? 0
  return {
    template_id: m.template_id,
    name: m.display_name || '未命名人才',
    category,
    description: m.description ?? '',
    preview_avatar_url: m.avatar_url,
    default_model_ref: m.model_name ? { model: m.model_name } : undefined,
    // 只收录 Agent 补齐了 display_name 的技能；技能 ID 是 UUID，对用户无意义，不展示也不参与筛选。
    // 数量仍以 skills_count 为准，禁止生成“技能 1”等占位标签。
    skills: [...new Set(m.platform_skill_refs?.map(ref => ref.display_name?.trim() ?? '').filter(Boolean) ?? [])],
    skills_count: skillsCount,
    tags: m.tags ?? [],
    recruit_count: recruitCount,
    is_recruited: m.is_recruited,
    profile: toTalentProfile(m),
  }
}

function marketplaceToDetail(m: MarketplaceTemplate): MarketTemplateDetail {
  const base = marketplaceToLocal(m)
  return {
    template_id: base.template_id,
    name: base.name,
    category: base.category,
    description: base.description,
    preview_avatar_url: base.preview_avatar_url,
    default_skills: base.skills,
    skills_count: base.skills_count,
    default_model_ref: base.default_model_ref,
    tags: base.tags,
    recruit_count: base.recruit_count,
    profile: base.profile,
  }
}

export async function fetchMarketAgents(
  query: MarketQuery = {},
  options: MarketRequestOptions = {},
): Promise<MarketListResponse> {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? Number.MAX_SAFE_INTEGER
  const requestKey = JSON.stringify({ page, pageSize, tag: query.tag, q: query.q })
  const cachedRequest = marketListRequests.get(requestKey)
  if (!options.force && cachedRequest) return cachedRequest

  // Agent 端目前不支持服务端 tag/q/分页参数,拿到全量后前端过滤 + 切片。
  const request = backendApi
    .listMarketplaceTemplates()
    .then(({ items: res }): MarketListResponse => {
      if (!Array.isArray(res)) throw new AgentApiError('人才目录响应格式不正确，请重试或联系管理员。', 200, { code: 'client_bad_catalog' })
      let items = res.map(marketplaceToLocal)
      const q = query.q?.trim().toLowerCase()
      if (q) {
        items = items.filter((it) =>
          it.name.toLowerCase().includes(q)
          || it.description.toLowerCase().includes(q)
          || it.tags.some((t) => t.toLowerCase().includes(q)),
        )
      }
      if (query.tag && query.tag !== ALL_CATEGORY.id) {
        items = items.filter((it) => it.category === query.tag || it.tags.includes(query.tag!))
      }
      const total = items.length
      const start = (page - 1) * pageSize
      const slice = items.slice(start, start + pageSize)
      return {
        items: slice,
        page,
        page_size: pageSize,
        total,
        has_more: start + slice.length < total,
      }
    })
    .finally(() => {
      if (marketListRequests.get(requestKey) === request) marketListRequests.delete(requestKey)
    })

  if (!options.force) marketListRequests.set(requestKey, request)
  return request
}

export async function fetchMarketTemplateDetail(id: string): Promise<MarketTemplateDetail> {
  return marketplaceToDetail(await backendApi.getMarketplaceTemplate(id))
}

/** 桌面端尚未接通招募接口：未招募人才只能浏览，招募需在企业后台完成。接通后改为 true。 */
export const RECRUITMENT_AVAILABLE = false

export async function recruitMarketAgent(_templateId: string, _displayName?: string, _idempotencyKey?: string): Promise<RecruitResponse> {
  throw new AgentApiError('当前服务未开放招募操作', 410, { code: 'recruitment_disabled' })
}
