import type { NavigateFunction } from 'react-router-dom'
import { agentApi } from '../../api/agent'
import type { ExpertProjection } from '../../api/agent/types'
import { useChatStore } from '../../stores/chat'
import { requestKnowledgeSource } from '../KnowledgeBase/api'
import { ENTERPRISE_ENDPOINT } from '../KnowledgeBase/knowledgeService'
import { readKnowledgeSourceConfig } from '../KnowledgeBase/knowledgeSourceConfig'
import { recordApplicationLog } from '../../lib/applicationLog'
import { employeeUnavailableMessage } from '../../lib/employeeAvailability'
import type { EmployeeChatFacts } from '../../lib/employeeChatStatus'
import { fetchMarketAgents } from './api'
import {
  findEmployeeConversationId,
  parseRecruitmentLinks,
  resolveTalentEmployees,
  talentChatBlockedReason,
  type RecruitmentLink,
} from './talentEmployees'

interface TalentEmployeeIndex { experts: ExpertProjection[]; links: RecruitmentLink[] }

/** 本机已授权专家 + 招募记录；按模板解析员工时共用，避免逐个模板重复请求。 */
async function loadTalentEmployeeIndex(): Promise<TalentEmployeeIndex> {
  const { experts } = await agentApi.listExperts()
  const links = readKnowledgeSourceConfig().enterpriseUrl
    ? parseRecruitmentLinks(await requestKnowledgeSource(ENTERPRISE_ENDPOINT, '/api/manager/recruit/orders'))
    : []
  return { experts, links }
}

/** 招募记录 ∩ 本机已授权专家，得到该人才模板下可用的真实员工实例；不按名称猜测身份。 */
export async function loadTalentEmployees(templateId: string): Promise<ExpertProjection[]> {
  const { experts, links } = await loadTalentEmployeeIndex()
  const matched = resolveTalentEmployees(templateId, experts, links)
  // 联调诊断：区分按来源字段命中与按招募记录回退命中，只记数量。
  recordApplicationLog('info', 'talent.employees.resolved', {
    count: experts.length,
    matched: matched.length,
    via_source: matched.filter(e => e.source_template_id === templateId).length,
    via_link: matched.filter(e => e.source_template_id !== templateId).length,
  })
  return matched
}

/** 人才市场当前列出的模板对应的员工 ID；模板未发布或模型未开放（不在目录里）的员工不在其中。 */
export async function loadMarketEmployeeIds(templateIds: string[]): Promise<Set<string>> {
  if (!templateIds.length) return new Set()
  const { experts, links } = await loadTalentEmployeeIndex()
  return new Set(templateIds.flatMap(templateId => resolveTalentEmployees(templateId, experts, links).map(employee => employee.employee_id)))
}

/**
 * 组织架构等页面用的后台事实：员工生命周期（暂停/下架/招募中）+ 模板是否在人才市场上架。
 * 有来源模板（source_template_id 或招募记录）但模板不在当前目录里的，记为 unlisted；没有来源模板的记为 none。
 */
export async function loadEmployeeMarketFacts(employeeIds: string[]): Promise<Record<string, Pick<EmployeeChatFacts, 'lifecycle' | 'listing'>>> {
  const [{ items }, { experts, links }] = await Promise.all([fetchMarketAgents(), loadTalentEmployeeIndex()])
  const listed = new Set(items.flatMap(item => resolveTalentEmployees(item.template_id, experts, links).map(employee => employee.employee_id)))
  const linked = new Set(links.map(link => link.employeeId))
  const byId = new Map(experts.map(expert => [expert.employee_id, expert]))
  return Object.fromEntries(employeeIds.map(id => {
    const expert = byId.get(id)
    const fromTemplate = Boolean(expert?.source_template_id) || linked.has(id)
    return [id, {
      lifecycle: expert ? { status: expert.status, revoked: expert.revoked, availability_reason: expert.availability_reason } : null,
      listing: listed.has(id) ? 'listed' : fromTemplate ? 'unlisted' : 'none',
    }]
  }))
}

/** 批量计算已招募人才不能发起对话的原因；能对话的模板不出现在结果里。 */
export async function loadTalentChatBlockedReasons(templateIds: string[]): Promise<Record<string, string>> {
  if (!templateIds.length) return {}
  const { experts, links } = await loadTalentEmployeeIndex()
  const blocked: Record<string, string> = {}
  for (const templateId of templateIds) {
    const reason = talentChatBlockedReason(resolveTalentEmployees(templateId, experts, links))
    if (reason) blocked[templateId] = reason
  }
  recordApplicationLog('info', 'talent.availability.resolved', { count: templateIds.length, blocked: Object.keys(blocked).length })
  return blocked
}

/**
 * 校验就绪后跳到对话页并激活该员工的会话：优先复用已有真实会话，没有才新建。
 * isActive 返回 false（页面已卸载/请求已过期）时不再新建或跳转。
 * draftMessage（示例问题）只写入该会话的输入框草稿，不自动发送。
 */
export async function startTalentEmployeeChat(
  employee: ExpertProjection,
  navigate: NavigateFunction,
  isActive: () => boolean = () => true,
  draftMessage?: string,
): Promise<void> {
  // 暂停/下架等生命周期状态直接给出中文原因；其余条件（技能、模型、runtime）仍以 readiness 为准。
  const unavailable = employeeUnavailableMessage(employee)
  if (unavailable) throw new Error(`${unavailable}。请联系企业管理员处理后刷新。`)
  const readiness = await agentApi.getExpertReadiness(employee.employee_id)
  if (!readiness.available) throw new Error(`员工尚未就绪：${readiness.reasons.join('；')}。请检查企业配置和本机授权。`)
  if (!isActive()) return
  let conversationId = findEmployeeConversationId(useChatStore.getState().conversations, employee.employee_id)
  if (!conversationId) {
    conversationId = (await agentApi.createConversation({ entry_employee_id: employee.employee_id })).id
    if (!isActive()) return
  }
  if (draftMessage?.trim()) useChatStore.getState().setConvDraft(conversationId, draftMessage.trim(), [])
  // introduce：会话为空时由对话页请求员工自我介绍；已有消息时对话页直接跳过。
  navigate('/chat', { state: { employeeId: employee.employee_id, conversationId, profileName: employee.display_name, agentName: employee.display_name, introduce: true, refreshWorkbench: true } })
}
