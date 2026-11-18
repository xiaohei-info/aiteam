/**
 * 工具权限审批全局状态。
 *
 * 事件源：会话 SSE 的 approval_required（chat 订阅与办公室订阅都会汇入）。
 * 决定提交：POST .../approvals/:id/decision（必须 Idempotency-Key，CAS revision）。
 * 错误语义：
 *   - 409 approval_expired / approval_conflict → 该条目标记为失效并提示
 *   - 其他错误保留条目允许重试
 * 过期：expires_at 到点自动标记 expired（服务端同样会过期，这里只是及时收敛 UI）。
 */
import { create } from 'zustand'
import { agentApi, AgentApiError } from '../api/agent'
import type { CapabilityResolution } from '../api/agent/approvals'
import type { McpLogin, PiSseEventData } from '../api/agent/types'
import { notifyApprovalRequired } from '../lib/systemNotifications'

const RISK_LABEL: Record<string, string> = {
  bash: '执行本机命令', write: '写入文件', edit: '修改文件', external: '访问外部资源',
}

export interface PendingApproval {
  approvalId: string
  conversationId: string
  toolName: string
  summary: string
  riskLevel: string
  expiresAt: string | null
  /** 收到事件时的总有效时长（ms），倒计时环以此为满刻度；不假设服务端 TTL 固定为 60s */
  totalMs: number | null
  decisionRevision?: number
  employee?: string
  /**
   * 'deciding' 提交中；'expired' 已过期/冲突失效；'error' 提交失败可重试；
   * 'signing_in' 已批准安装需要浏览器登录的 MCP，等待成员在服务方网页登录（MCP 鉴权 2026-11-18）。
   */
  phase: 'pending' | 'deciding' | 'expired' | 'error' | 'signing_in'
  errorMessage?: string
  /** signing_in：Agent 返回的登录进度；还没开始登录时为空。 */
  login?: McpLogin | null
  /** signing_in：进入等待登录的时刻（ms），用于判断迟迟拿不到登录进度。 */
  signInSince?: number
}

/** 批准时随决定提交的附加内容。 */
export interface DecideOptions {
  resolution?: CapabilityResolution
  remember?: boolean
  /** 本会话内不再询问该外部工具（只对 risk_level=external 有效）。 */
  sessionAllow?: boolean
  /** 需要访问令牌的 MCP：令牌只交给本机 Agent。 */
  credential?: { token: string; header?: string }
  /** 需要浏览器登录的 MCP：批准后进入等待登录，而不是关闭弹窗。 */
  signIn?: boolean
}

interface ApprovalStore {
  pending: PendingApproval[]
  addFromSse: (event: PiSseEventData, conversationId: string) => void
  decide: (approvalId: string, decision: 'approve' | 'deny', options?: DecideOptions) => Promise<void>
  dismiss: (approvalId: string) => void
  /** signing_in 时写入最新登录进度。 */
  setLogin: (approvalId: string, login: McpLogin | null) => void
  /** 登录失败或读不到进度：保留条目显示原因，由成员关闭。 */
  failSignIn: (approvalId: string, message: string) => void
  pruneExpired: () => void
}

/** 令牌被服务方拒绝 / 格式不对：可重填，审批仍有效。 */
function credentialProblem(error: unknown): string | null {
  const code = error instanceof AgentApiError ? error.code : undefined
  if (code === 'invalid_mcp_token') return '服务方拒绝了这个令牌，请检查后重新填写'
  if (code === 'invalid_approval_credential') return '令牌或请求头名格式不对，请检查后重新填写'
  return null
}

export const useApprovalStore = create<ApprovalStore>((set, get) => ({
  pending: [],

  addFromSse: (event, conversationId) => {
    const approvalId = event.approvalId ?? event.approval_id
    if (typeof approvalId !== 'string' || !approvalId) return
    if (!get().pending.some((p) => p.approvalId === approvalId)) {
      void notifyApprovalRequired({
        employee: event.source_employee_display_name,
        toolLabel: RISK_LABEL[typeof event.riskLevel === 'string' ? event.riskLevel : ''] ?? '调用工具',
      })
    }
    set((state) => {
      if (state.pending.some((p) => p.approvalId === approvalId)) return {}
      const item: PendingApproval = {
        approvalId,
        conversationId,
        toolName: typeof event.toolName === 'string' ? event.toolName : 'unknown',
        summary: typeof event.summary === 'string' ? event.summary : '',
        riskLevel: typeof event.riskLevel === 'string' ? event.riskLevel : 'unknown',
        expiresAt: typeof event.expiresAt === 'string' ? event.expiresAt : null,
        totalMs: typeof event.expiresAt === 'string' && Number.isFinite(Date.parse(event.expiresAt))
          ? Math.max(1000, Date.parse(event.expiresAt) - Date.now())
          : null,
        decisionRevision: typeof event.decisionRevision === 'number' ? event.decisionRevision : undefined,
        employee: event.source_employee_display_name,
        phase: 'pending',
      }
      return { pending: [...state.pending, item] }
    })
    get().pruneExpired()
  },

  decide: async (approvalId, decision, options = {}) => {
    const item = get().pending.find((p) => p.approvalId === approvalId)
    if (!item || item.phase === 'deciding') return
    set((state) => ({
      pending: state.pending.map((p) => p.approvalId === approvalId ? { ...p, phase: 'deciding', errorMessage: undefined } : p),
    }))
    try {
      await agentApi.decideApproval(
        item.conversationId,
        approvalId,
        decision,
        crypto.randomUUID(),
        item.decisionRevision,
        undefined,
        decision === 'approve' ? options.resolution : undefined,
        decision === 'approve' && options.remember === true,
        decision === 'approve' ? options.credential : undefined,
        decision === 'approve' && options.sessionAllow === true,
      )
      if (decision === 'approve' && options.signIn) {
        set((state) => ({
          pending: state.pending.map((p) => p.approvalId === approvalId ? { ...p, phase: 'signing_in', login: null, signInSince: Date.now(), errorMessage: undefined } : p),
        }))
        return
      }
      set((state) => ({ pending: state.pending.filter((p) => p.approvalId !== approvalId) }))
    } catch (error) {
      const expired = error instanceof AgentApiError && error.status === 409
      set((state) => ({
        pending: state.pending.map((p) => p.approvalId === approvalId
          ? {
              ...p,
              phase: expired ? 'expired' : 'error',
              errorMessage: expired
                ? '该审批已过期或被处理，请让员工重试'
                : credentialProblem(error) ?? (error instanceof Error ? error.message : '提交失败，请重试'),
            }
          : p),
      }))
    }
  },

  setLogin: (approvalId, login) => {
    set((state) => ({ pending: state.pending.map((p) => p.approvalId === approvalId && p.phase === 'signing_in' ? { ...p, login } : p) }))
  },

  failSignIn: (approvalId, message) => {
    set((state) => ({ pending: state.pending.map((p) => p.approvalId === approvalId && p.phase === 'signing_in' ? { ...p, errorMessage: message } : p) }))
  },

  dismiss: (approvalId) => {
    set((state) => ({ pending: state.pending.filter((p) => p.approvalId !== approvalId) }))
  },

  pruneExpired: () => {
    const now = Date.now()
    set((state) => ({
      pending: state.pending.map((p) =>
        p.phase === 'pending' && p.expiresAt && Date.parse(p.expiresAt) <= now
          ? { ...p, phase: 'expired', errorMessage: '审批已超时过期' }
          : p),
    }))
  },
}))
