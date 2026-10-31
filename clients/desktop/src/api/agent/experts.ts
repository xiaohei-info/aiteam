/**
 * 授权员工/专家投影接口。
 *
 * FredServer 侧路由:
 *   GET /api/agent/grants/experts        列出当前成员已授权的专家投影
 *   GET /api/agent/grants/readiness      Agent runtime + 专家就绪情况
 *
 * 与旧 Hermes /employees 的关键差异:
 *   1. 无 conversation_id 字段。员工→会话映射从会话列表 entry_employee_id 反向推导。
 *   2. 无企业全员概念。返回的是"当前身份在目标服务已装载的授权专家",群聊 roster 必须
 *      基于这份数据 / solution roster,不能默认为企业全员。
 *   3. 列表只读取目标服务的投影；登录和恢复会话时先同步当前成员授权。
 */
import type { ServiceApiClient } from './client'
import { recordApplicationLog } from '../../lib/applicationLog'
import type { ExpertProjection, Page, SolutionProjection } from './types'

// 列表接口返回 { data: ExpertProjection[], page: Page }。client 已 unwrap envelope,
// 这里再手动展开一层拿数组主体;分页字段目前不使用,预留返回。
export interface ExpertsListResult {
  experts: ExpertProjection[]
  page: Page
}

export async function listExperts(client: ServiceApiClient): Promise<ExpertsListResult> {
  // envelope 已在 client 层解包,所以这里拿到的是 { data:..., page:... } 之外的
  // 直接 payload 结构。为了避免 client 把整个 envelope 里的 data 当成结果吐出来,
  // 我们请求 raw 然后自己抽字段更稳。
  const payload = await client.request<{ data: ExpertProjection[]; page: Page }>({
    method: 'GET',
    path: '/api/agent/grants/experts',
    raw: true,
  })
  const experts = payload.data ?? []
  // 联调诊断：只记数量，不记员工或模板 ID。
  recordApplicationLog('info', 'agent.experts.provenance', {
    count: experts.length,
    with_source: experts.filter(e => typeof e.source_template_id === 'string' && e.source_template_id !== '').length,
    null_source: experts.filter(e => e.source_template_id === null).length,
    missing_source: experts.filter(e => e.source_template_id === undefined).length,
  })
  return { experts, page: payload.page ?? { next_cursor: null, has_more: false } }
}

export interface SolutionsListResult {
  solutions: SolutionProjection[]
  page: Page
}

// 群成员的事实源。Agent 会在创建 solution group 时把 solution_instance_id
// 持久化到会话，并按该投影的 expert_employee_ids 初始化固定参与者。
export async function listSolutions(client: ServiceApiClient): Promise<SolutionsListResult> {
  const payload = await client.request<{ data: SolutionProjection[]; page: Page }>({
    method: 'GET',
    path: '/api/agent/grants/solutions',
    raw: true,
  })
  return {
    solutions: payload.data ?? [],
    page: payload.page ?? { next_cursor: null, has_more: false },
  }
}

export interface ExpertReadiness { available: boolean; reasons: string[] }

// 单个专家就绪状态。UI 层用来判断"点这个员工能不能立刻发消息"。
export async function getExpertReadiness(
  client: ServiceApiClient,
  employeeId: string,
): Promise<ExpertReadiness> {
  const payload = await client.request<unknown>({
    method: 'GET',
    path: `/api/agent/grants/experts/${encodeURIComponent(employeeId)}/readiness`,
  })
  if (!payload || typeof payload !== 'object' || !('available' in payload) || typeof payload.available !== 'boolean'
    || !('reasons' in payload) || !Array.isArray(payload.reasons) || !payload.reasons.every((reason: unknown) => typeof reason === 'string')) {
    throw new Error('员工就绪状态响应无效，请重试')
  }
  return { available: payload.available, reasons: payload.reasons }
}
