import type { TemplateUsageMetrics } from '../../lib/usageDisplay'
import type { TalentProfile } from './talentProfile'

export interface MarketCategory {
  id: string
  label: string
  icon?: string
  count?: number
}

export interface MarketTemplate extends TemplateUsageMetrics {
  template_id: string
  name: string
  category: string
  description: string
  preview_avatar_url?: string | null
  default_model_ref?: { max_tokens?: number; temperature?: number; provider?: string; model?: string }
  skills: string[]
  skills_count: number
  tags: string[]
  recruit_count: number | null
  is_recruited: boolean
  level?: string
  /** 议题 7 展示字段；旧模板为空画像。 */
  profile: TalentProfile
}

export interface MarketListResponse {
  items: MarketTemplate[]
  page: number
  page_size: number
  total: number
  has_more: boolean
  facets?: Record<string, unknown>
}

export interface MarketTemplateDetail extends TemplateUsageMetrics {
  template_id: string
  name: string
  category: string
  description: string
  preview_avatar_url?: string | null
  default_skills: string[]
  skills_count: number
  default_model_ref?: { max_tokens?: number; temperature?: number; provider?: string; model?: string }
  default_memory_config?: object
  knowledge_bindings?: object[]
  connector_requirements?: object[]
  level?: string
  recruit_count: number | null
  tags?: string[]
  profile: TalentProfile
}

export interface RecruitResponse {
  order_id: string
  status: string
  employee_id: string
  profile_name: string
  conversation_id: string
  navigation?: {
    workbench?: string
    employee_admin?: string
    chat?: string
  }
}
