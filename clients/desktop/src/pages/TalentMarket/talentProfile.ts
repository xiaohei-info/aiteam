// 人才市场展示字段（议题 7「人才市场字段细化」）的映射与格式化规则。
// 规则：没有数据的字段整行/整块隐藏，不出现「数据未提供」；解决率样本不足时显示「样本不足」，绝不显示 0%。
import type { Connector } from '../../api/agent/automationTasks'
import type {
  MarketplaceOutputType,
  MarketplacePricingMode,
  MarketplaceTemplate,
  MarketplaceTemplatePricing,
  MarketplaceTemplateStats,
} from '../../api/agent/types'

export interface TalentSkill {
  name: string
  summary: string | null
  version: string
}

export interface TalentSampleOutput {
  title: string
  output_type: MarketplaceOutputType
  preview_url: string | null
}

export interface TalentProfile {
  tagline: string | null
  use_cases: string[]
  limitations: string[]
  example_prompts: string[]
  sample_outputs: TalentSampleOutput[]
  output_types: MarketplaceOutputType[]
  required_connectors: string[]
  optional_connectors: string[]
  recommended_knowledge: string[]
  required_permissions: { full_access: boolean; local_directories: boolean } | null
  pricing: MarketplaceTemplatePricing | null
  memory_policy_summary: string | null
  publisher: string | null
  version: string | null
  updated_at: string | null
  changelog_url: string | null
  stats: MarketplaceTemplateStats | null
  /** 只含 Agent 补齐了展示名的技能；技能 ID 是 UUID，对用户无意义。 */
  skill_details: TalentSkill[]
}

export const OUTPUT_TYPE_LABELS: Record<MarketplaceOutputType, string> = {
  document: '文档',
  spreadsheet: '表格',
  code: '代码',
  presentation: '演示',
  system_operation: '操作外部系统',
}

export const PRICING_MODE_LABELS: Record<MarketplacePricingMode, string> = {
  per_call: '按次',
  per_token: '按 Token',
  subscription: '套餐',
}

const TAGLINE_MAX_LENGTH = 40
export const CARD_TAG_LIMIT = 3
export const CARD_OUTPUT_TYPE_LIMIT = 4
export const CARD_METRIC_SLOTS = 3

function text(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function texts(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
}

function httpUrl(value: string | null | undefined): string | null {
  const url = text(value)
  return url && /^https?:\/\/\S+$/u.test(url) ? url : null
}

function isOutputType(value: unknown): value is MarketplaceOutputType {
  return typeof value === 'string' && value in OUTPUT_TYPE_LABELS
}

export function emptyTalentProfile(): TalentProfile {
  return {
    tagline: null,
    use_cases: [],
    limitations: [],
    example_prompts: [],
    sample_outputs: [],
    output_types: [],
    required_connectors: [],
    optional_connectors: [],
    recommended_knowledge: [],
    required_permissions: null,
    pricing: null,
    memory_policy_summary: null,
    publisher: null,
    version: null,
    updated_at: null,
    changelog_url: null,
    stats: null,
    skill_details: [],
  }
}

/** 旧版随包 Agent 不返回这些字段时得到空画像，卡片和详情按旧模板渲染。 */
export function toTalentProfile(m: MarketplaceTemplate): TalentProfile {
  const stats = m.stats
  const rate = stats?.resolution_rate
  return {
    tagline: text(m.tagline),
    use_cases: texts(m.use_cases),
    limitations: texts(m.limitations),
    example_prompts: texts(m.example_prompts),
    sample_outputs: (m.sample_outputs ?? []).flatMap(output => {
      const title = text(output.title)
      return title && isOutputType(output.output_type)
        ? [{ title, output_type: output.output_type, preview_url: httpUrl(output.preview_url) }]
        : []
    }),
    output_types: [...new Set((m.output_types ?? []).filter(isOutputType))],
    required_connectors: texts(m.required_connectors),
    optional_connectors: texts(m.optional_connectors),
    recommended_knowledge: texts(m.recommended_knowledge),
    required_permissions: m.required_permissions
      ? { full_access: m.required_permissions.full_access === true, local_directories: m.required_permissions.local_directories === true }
      : null,
    pricing: m.pricing && m.pricing.mode in PRICING_MODE_LABELS && Number.isFinite(Number(m.pricing.unit_price)) ? m.pricing : null,
    memory_policy_summary: text(m.memory_policy_summary),
    publisher: text(m.publisher),
    version: text(m.version),
    updated_at: m.updated_at && Number.isFinite(Date.parse(m.updated_at)) ? m.updated_at : null,
    changelog_url: httpUrl(m.changelog_url),
    stats: stats
      ? {
          resolution_rate: typeof rate === 'number' && rate >= 0 && rate <= 1 ? rate : null,
          evaluated_segments: stats.evaluated_segments,
          resolved_segments: stats.resolved_segments,
          min_sample: stats.min_sample,
        }
      : null,
    skill_details: (m.platform_skill_refs ?? []).flatMap(ref => {
      const name = text(ref.display_name)
      return name ? [{ name, summary: text(ref.summary), version: ref.version }] : []
    }),
  }
}

/** 一句话定位；缺失时取岗位描述前 40 字（按码点截断）。 */
export function talentTagline(tagline: string | null, description: string): string {
  if (tagline) return tagline
  const chars = [...description.trim()]
  return chars.length > TAGLINE_MAX_LENGTH ? `${chars.slice(0, TAGLINE_MAX_LENGTH).join('')}…` : chars.join('')
}

/** 计价参考价；per_token 的单价是每百万 Token。 */
export function formatTemplatePricing(pricing: MarketplaceTemplatePricing): string {
  const price = `$${Number(pricing.unit_price)}`
  if (pricing.mode === 'per_call') return `${price}/次`
  if (pricing.mode === 'per_token') return `${price}/百万 Token`
  return `${price} 套餐`
}

export type SolveRateTone = 'success' | 'primary' | 'warning'

/** ≥80% 成功色，60%–80% 常规色，<60% 警告色。 */
export function solveRateTone(rate: number): SolveRateTone {
  if (rate >= 0.8) return 'success'
  if (rate >= 0.6) return 'primary'
  return 'warning'
}

export function formatSolveRate(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/** 详情页解决率：样本不足时说明还差多少，而不是显示 0%。 */
export function solveRateSummary(stats: MarketplaceTemplateStats): string {
  if (stats.resolution_rate === null) {
    return `样本不足（已评估 ${stats.evaluated_segments} 段，满 ${stats.min_sample} 段后显示）`
  }
  return `${formatSolveRate(stats.resolution_rate)}（已评估 ${stats.evaluated_segments} 段）`
}

export interface TalentCardMetric {
  label: string
  value: string
  tone?: SolveRateTone
}

interface TalentCardMetricSource {
  profile: TalentProfile
  recruit_count: number | null
  skills_count: number
  model?: string
}

/** 卡片关键指标：按 解决率 → 招募 → 计价 → 技能 → 模型 取前 3 个有数据的；样本不足的解决率不上卡片。 */
export function talentCardMetrics({ profile, recruit_count, skills_count, model }: TalentCardMetricSource): TalentCardMetric[] {
  const rate = profile.stats?.resolution_rate
  const modelName = model?.trim()
  const candidates: Array<TalentCardMetric | null> = [
    typeof rate === 'number' ? { label: '解决率', value: formatSolveRate(rate), tone: solveRateTone(rate) } : null,
    typeof recruit_count === 'number' ? { label: '招募', value: recruit_count.toLocaleString('zh-CN') } : null,
    profile.pricing ? { label: '计价', value: formatTemplatePricing(profile.pricing) } : null,
    { label: '技能', value: `${skills_count} 项` },
    modelName ? { label: '模型', value: modelName } : null,
  ]
  return candidates.filter((metric): metric is TalentCardMetric => metric !== null).slice(0, CARD_METRIC_SLOTS)
}

export interface TalentConnectorStatus {
  key: string
  name: string
  /** null 表示本机连接器列表读取失败，不判断是否开通。 */
  enabled: boolean | null
}

/** 模板声明的连接器标识对照本机已启用连接器（按 ID 或展示名，不区分大小写）。 */
export function connectorStatuses(keys: readonly string[], enabledConnectors: readonly Connector[] | null): TalentConnectorStatus[] {
  return keys.map(key => {
    if (!enabledConnectors) return { key, name: key, enabled: null }
    const normalized = key.toLowerCase()
    const match = enabledConnectors.find(connector => connector.status === 'enabled'
      && (connector.connector_id.toLowerCase() === normalized || connector.display_name.trim().toLowerCase() === normalized))
    return { key, name: match?.display_name || key, enabled: Boolean(match) }
  })
}

/** 详情页需要的权限文案；未声明或都不需要时返回空列表。 */
export function requiredPermissionLabels(permissions: TalentProfile['required_permissions']): string[] {
  return [
    permissions?.full_access ? '需要允许完全访问' : '',
    permissions?.local_directories ? '需要授权本机目录' : '',
  ].filter(Boolean)
}

/** 接入要求是否整体为空：为空时详情显示「无需额外配置」。 */
export function hasTalentRequirements(profile: TalentProfile): boolean {
  return profile.required_connectors.length > 0
    || profile.optional_connectors.length > 0
    || profile.recommended_knowledge.length > 0
    || requiredPermissionLabels(profile.required_permissions).length > 0
}

/** 「v1.4 · 10/21 更新」；缺失的部分不显示。 */
export function talentReleaseLabel(profile: Pick<TalentProfile, 'version' | 'updated_at'>): string {
  const parts: string[] = []
  if (profile.version) parts.push(`v${profile.version.replace(/^v/i, '')}`)
  if (profile.updated_at) {
    const date = new Date(profile.updated_at)
    parts.push(`${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} 更新`)
  }
  return parts.join(' · ')
}
