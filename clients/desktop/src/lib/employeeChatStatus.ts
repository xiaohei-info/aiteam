export type EmployeeChatState =
  | 'checking'
  | 'available'
  | 'paused'
  | 'archived'
  | 'ungranted'
  | 'provisioning'
  | 'provisioning_failed'
  | 'unlisted'
  | 'model_unavailable'
  | 'not_ready'
  | 'unknown'

/** ok=可对话，warn=可恢复的阻塞，off=需要企业后台处理，muted=过程中或未知。 */
export type EmployeeChatTone = 'ok' | 'warn' | 'off' | 'muted'

export interface EmployeeChatStatusDisplay {
  state: EmployeeChatState
  tone: EmployeeChatTone
  label: string
  detail: string
}

export interface EmployeeReadiness { available: boolean; reasons?: string[] }

/** 员工在企业后台的生命周期，取自本机授权投影（grants/experts）。 */
export interface EmployeeLifecycle { status?: string; revoked?: boolean; availability_reason?: string }

/**
 * 组合判断需要的事实；缺失的字段表示没查到，只用剩下的事实判断。
 * - lifecycle=null：授权投影已加载但没有该员工（本机未授权）
 * - listing：'listed' 模板在人才市场上架；'unlisted' 有来源模板但当前未上架；'none' 不来自人才市场（如系统主持人）
 * - readiness=null：readiness 查询失败
 */
export interface EmployeeChatFacts {
  readiness?: EmployeeReadiness | null
  lifecycle?: EmployeeLifecycle | null
  listing?: 'listed' | 'unlisted' | 'none'
}

export const EMPLOYEE_CHAT_CHECKING: EmployeeChatStatusDisplay = Object.freeze({
  state: 'checking',
  tone: 'muted',
  label: '检查中',
  detail: '正在检查能否发起对话',
})

export const EMPLOYEE_CHAT_UNKNOWN: EmployeeChatStatusDisplay = Object.freeze({
  state: 'unknown',
  tone: 'muted',
  label: '状态未知',
  detail: '暂时查不到能否发起对话，请稍后刷新重试',
})

// Agent readiness 的原因是英文开发者文案，这里转成用户能看懂的中文；没收录的原样保留。
const READINESS_REASON_LABELS: Record<string, string> = {
  'Manager has not activated this expert': '员工未启用',
  'Pi runtime is not ready': '本机运行环境未就绪',
  'Employee model, provider or price is unavailable': '员工使用的模型暂不可用',
  'Employee is unavailable': '员工已下架',
  'Manager snapshot has no model provider': '员工未配置模型',
  'Expert is not authorized locally': '本机未获得该员工的授权',
}

export function describeReadinessReason(reason: string): string {
  const known = READINESS_REASON_LABELS[reason]
  if (known) return known
  const skill = /^Required skill (.+): .+$/.exec(reason)
  return skill ? `技能「${skill[1]}」未就绪` : reason
}

function readinessDetail(readiness: EmployeeReadiness): string {
  const reasons = [...new Set((readiness.reasons ?? []).map(describeReadinessReason))]
  return reasons.length ? reasons.join('；') : '员工尚未就绪'
}

function display(state: EmployeeChatState, tone: EmployeeChatTone, label: string, detail: string): EmployeeChatStatusDisplay {
  return { state, tone, label, detail }
}

/**
 * 按「企业后台状态 → 人才市场上架 → 本机 readiness」的顺序给出最主要的一个状态：
 * 先说后台为什么停用（暂停、下架、招募中），再说模板是否上架，最后才是技能、模型、运行环境这类就绪问题。
 */
export function resolveEmployeeChatStatus(facts: EmployeeChatFacts): EmployeeChatStatusDisplay {
  const { readiness, lifecycle, listing } = facts
  if (lifecycle === null || lifecycle?.revoked) {
    return display('ungranted', 'off', '未授权', '本机没有该员工的授权，请在企业后台完成成员授权')
  }
  const status = lifecycle?.status
  if (status === 'archived' || lifecycle?.availability_reason === 'employee_unavailable') {
    return display('archived', 'off', '已下架', '员工已被企业下架，无法发起对话')
  }
  if (status === 'paused') return display('paused', 'warn', '已暂停', '企业管理员已暂停该员工，恢复后可以对话')
  if (status === 'draft' || status === 'provisioning') return display('provisioning', 'muted', '招募中', '员工还在创建中，完成后可以对话')
  if (status === 'provisioning_failed') return display('provisioning_failed', 'off', '招募失败', '员工创建失败，请在企业后台重新招募')
  if (lifecycle?.availability_reason === 'employee_dependency_unavailable') {
    return display('model_unavailable', 'warn', '模型不可用', '员工使用的模型、服务商或价格暂不可用')
  }
  if (listing === 'unlisted') {
    const chat = readiness?.available ? '仍可以发起对话' : readiness ? `目前不能对话：${readinessDetail(readiness)}` : '能否对话暂时查不到'
    return display('unlisted', 'warn', '模板未上架', `人才市场未上架该员工的模板，员工不在人才市场和办公室显示；${chat}`)
  }
  if (readiness === undefined) return EMPLOYEE_CHAT_CHECKING
  if (readiness === null) return EMPLOYEE_CHAT_UNKNOWN
  if (readiness.available) return display('available', 'ok', '可对话', '可以发起对话')
  return display('not_ready', 'warn', '未就绪', readinessDetail(readiness))
}

/** 逐个查询 readiness；单个员工查询失败记为 null（显示「状态未知」），不当作可对话或不可对话。 */
export async function loadEmployeeReadiness(
  employeeIds: string[],
  getReadiness: (employeeId: string) => Promise<EmployeeReadiness>,
): Promise<Record<string, EmployeeReadiness | null>> {
  const ids = [...new Set(employeeIds)]
  const results = await Promise.allSettled(ids.map(id => getReadiness(id)))
  return Object.fromEntries(ids.map((id, index) => {
    const result = results[index]
    return [id, result.status === 'fulfilled' ? result.value : null]
  }))
}
