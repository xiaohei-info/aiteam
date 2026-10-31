/**
 * 工具权限审批 API。
 *
 * 服务端（FredServer agent_service）：
 *   GET  /api/agent/conversations/:id/approvals                     列出审批记录
 *   POST /api/agent/conversations/:id/approvals/:approval_id/decision  提交决定
 * 约束：
 *   - decision 仅 approve | deny；必须携带 Idempotency-Key
 *   - expected_revision 用于 CAS 防并发冲突
 *   - 409 approval_expired / approval_conflict 需 UI 区分提示
 */
import type { AgentApiClient } from './client'

export type ApprovalRiskLevel = 'bash' | 'write' | 'edit' | 'external' | 'unknown'
export type ApprovalStatus =
  | 'pending' | 'approved' | 'executing' | 'succeeded'
  | 'rejected' | 'invalidated' | 'expired' | 'uncertain'

export interface ApprovalRecord {
  id: string
  approval_batch_id: string | null
  conversation_id: string
  participant_employee_id: string | null
  session_id: string | null
  snapshot_version: string
  permission_revision: string
  tool_call_id: string
  tool_name: string
  canonical_args_hmac: string
  /** 服务端脱敏后的参数预览，可直接展示 */
  redacted_summary: string
  risk_level: ApprovalRiskLevel
  status: ApprovalStatus
  approved_by: string | null
  approved_at: string | null
  expires_at: string
  decision_revision: number
  consumed: boolean
  created_at: string
  updated_at: string
}

export type ApprovalDecision = 'approve' | 'deny'

export const approvals = (client: AgentApiClient) => ({
  listApprovals: (conversationId: string, signal?: AbortSignal) =>
    client.request<{ data: ApprovalRecord[] }>({
      path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/approvals`,
      raw: true,
      signal,
    }),
  decideApproval: (
    conversationId: string,
    approvalId: string,
    decision: ApprovalDecision,
    idempotencyKey: string,
    expectedRevision?: number,
    signal?: AbortSignal,
  ) =>
    client.request<{ data: ApprovalRecord }>({
      method: 'POST',
      path: `/api/agent/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      body: expectedRevision === undefined ? { decision } : { decision, expected_revision: expectedRevision },
      idempotencyKey,
      raw: true,
      signal,
    }),
})
