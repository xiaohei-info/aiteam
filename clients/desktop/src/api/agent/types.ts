/**
 * FredServer agent_service TypeBox schema 的前端镜像。
 * SSOT 在 server/agent_service/src/http/server.ts,此处只镜像用到的字段。
 * 新增字段时按需补齐,不必与服务端一一对应。
 */

// -------------------- 认证 --------------------

export interface TenantResolution {
  tenant_id: string
}

export interface AuthClaims {
  user_id: string
  // Agent 成功身份必须具有明确的企业。
  tenant_id: string
  roles: string[]
  iss?: string
  aud?: string | string[]
  exp?: number
}

export interface AuthResult {
  token: string
  claims: AuthClaims
}

// -------------------- 分页 --------------------

// FredServer Page schema。列表接口的 next_cursor 为 null 表示末页。
export interface Page {
  next_cursor: string | null
  has_more: boolean
}

// -------------------- 会话元数据 --------------------

// FredServer server/agent_service/src/storage/sqlite.ts ConversationState。
export type ConversationStateValue = 'draft' | 'active' | 'paused' | 'muted' | 'archived'

// FredServer server/agent_service/src/storage/sqlite.ts ConversationPermissionMode。
export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access'

// 思考档位,server.ts ThinkingLevel。
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// 会话定时执行配置。前端目前只透传,不解析,细节留在 server 侧。
export interface ConversationSchedule {
  revision: number
  enabled: boolean
  one_shot: boolean
  overlap: string
  misfire: string
  // 其余字段(cron / at / timezone 等)按需补齐;当前 UI 尚未使用。
  [key: string]: unknown
}

// GET /conversations、POST /conversations 的响应主体(envelope.data)。
export interface ConversationMetadata {
  description?: string | null
  orchestration?: import('./customGroups').GroupOrchestration | null
  id: string
  title: string | null
  // 'chat' 私聊 / 'group' 群聊 / 后续可能有 'task' 等。
  kind: string
  labels: string[]
  state: ConversationStateValue
  entry_employee_id: string | null
  coordinator_employee_id: string | null
  solution_instance_id: string | null
  tenant_id?: string | null
  member_id?: string | null
  schedule: ConversationSchedule | null
  permission_mode: PermissionMode
  last_read_entry_id: string | null
  created_at: string
  updated_at: string
  // B1 服务端摘要字段；字段缺失与显式 null 语义不同，前端必须保留“未提供”状态。
  last_preview?: string | null
  unread_count?: number
  // 最新可见 user/assistant 消息时间；null 也可能是旧消息时间缺失，不代表一定为空会话。
  // 保留 optional 以兼容旧 Agent；不能用 updated_at（改名/已读时间）兜底。
  last_message_at?: string | null
}

// POST /conversations 请求体。除 kind 缺省为 'chat' 外,其他字段全部可选。
export interface ConversationCreateRequest {
  id?: string
  title?: string | null
  kind?: 'chat' | 'group' | string
  labels?: string[]
  entry_employee_id?: string | null
  coordinator_employee_id?: string | null
  solution_instance_id?: string | null
  permission_mode?: PermissionMode
  schedule?: ConversationSchedule | null
}

// PATCH /conversations/:id 请求体。仅提供的字段会更新。
export interface ConversationUpdateRequest {
  title?: string | null
  description?: string | null
  orchestration?: import('./customGroups').GroupOrchestration | null
  kind?: string
  labels?: string[]
  permission_mode?: PermissionMode
  schedule?: ConversationSchedule | null
  last_read_entry_id?: string | null
}

// GET /conversations/:id/state。prompting 是瞬时运行态。
export interface ConversationStateOut {
  conversation_id: string
  state: ConversationStateValue
  prompting: boolean
}

// GET /conversations/:id/receipts/:idempotency_key。202 只表示已接受，执行在后台异步开始；
// accepted 表示这次提示尚未到终态，completed/unknown 才说明这一轮已结束。
export interface PromptReceiptOut {
  conversation_id: string
  idempotency_key: string
  state: 'accepted' | 'completed' | 'unknown' | string
  last_entry_id: string | null
  failure_code: string | null
  failure_detail: string | null
}

// GET /conversations/:id/context。model / used_tokens / percentage 可能为 null。
export interface ConversationContextModel {
  provider: string
  id: string
  name: string
}
export interface ConversationContextOut {
  conversation_id: string
  employee_id: string
  model: ConversationContextModel | null
  used_tokens: number | null
  context_window: number
  percentage: number | null
  thinking_level: ThinkingLevel
  available_thinking_levels: ThinkingLevel[]
  prompting: boolean
}

// POST /conversations/:id/context/reset。记忆提交是异步的,saved 只表示 Manager 已受理。
// 直接重置:saved / empty / skipped / retain_disabled / policy。
// 临时失败:unauthorized / too_large / manager_unavailable / retention_unverified / timeout,
// 默认不重置,用户确认后带 on_memory_failure='proceed' 再调。error 只出现在旧版本写入的标记里。
export type ContextResetMemoryReason =
  | 'saved' | 'empty' | 'skipped' | 'retain_disabled' | 'policy'
  | 'unauthorized' | 'too_large' | 'manager_unavailable' | 'retention_unverified' | 'timeout'
  | 'error'
export interface ContextResetRequest extends ContextSegmentEvaluation {
  // 默认 true;false 时不保存记忆直接重置。
  save_memory?: boolean
  // 默认 'abort';'proceed' 表示用户已确认,记忆保存失败也重置。确认重试时须再次携带评估字段。
  on_memory_failure?: 'abort' | 'proceed'
}
export interface ContextResetParticipant {
  employee_id: string
  reset: boolean
  // 上下文此前已重置且之后没有新对话,返回的是上一次的结果。
  already_reset: boolean
  reset_id: string | null
  message_count: number
  memory_saved: boolean
  memory_reason: ContextResetMemoryReason
  operation_id: string | null
}
export interface ContextResetResult {
  conversation_id: string
  reset_id: string
  reset: boolean
  already_reset: boolean
  // 有参与者因记忆保存失败保留了上下文,需要用户确认。
  confirmation_required: boolean
  memory_saved: boolean
  participants: ContextResetParticipant[]
  // 以下三项旧版随包 Agent 不返回。segment_id 等于 reset_id;未重置或重放的旧重置为 null。
  segment_id?: string | null
  outcome?: ContextSegmentOutcome | null
  segment?: ContextSegment | null
}

// 上下文段落:两次重置之间的一段对话,segment_id 等于结束它的 reset_id。
export type ContextSegmentOutcome = 'resolved' | 'unresolved'
export type ContextOutcomeReason = 'off_topic' | 'missing_info' | 'execution_failed' | 'wrong_result' | 'too_slow' | 'other'
// 重置请求与段落 PATCH 共用的评估字段;outcome 省略为未评估,原因只能配 unresolved。
export interface ContextSegmentEvaluation {
  outcome?: ContextSegmentOutcome
  outcome_reasons?: ContextOutcomeReason[]
  // ≤500 字。
  outcome_note?: string
  follow_up?: boolean
}
export interface ContextSegment {
  segment_id: string
  conversation_id: string
  employee_ids: string[]
  message_count: number
  outcome: ContextSegmentOutcome | null
  outcome_reasons: ContextOutcomeReason[]
  outcome_note: string | null
  follow_up: boolean
  revision: number
  ended_at: string
  evaluated_at: string | null
  // 结束后 7 天内可修改评估。
  editable_until: string
}
// PATCH /conversations/:id/segments/:segment_id。outcome=null 撤销评估;revision 不一致返回 409 segment_revision_conflict,
// 超过 editable_until 返回 409 segment_edit_window_closed。
export interface ContextSegmentUpdateRequest extends Omit<ContextSegmentEvaluation, 'outcome'> {
  outcome: ContextSegmentOutcome | null
  revision: number
}

// 重置标记条目:type='custom' 且 customType 为该值,data.reset_id 同一次重置在群聊各参与者间共享。
export const CONTEXT_RESET_ENTRY_TYPE = 'aiteam_context_reset'

// -------------------- Entries(历史) --------------------

// server.ts ConversationContentPart。前端消息渲染要按 type 分流。
export type ConversationContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id?: string; name?: string; arguments?: unknown }
  | { type: 'image' }

// server.ts ConversationMessage。assistant 消息可能含 text/thinking/toolCall 混合。
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'toolResult'
  timestamp?: number
  content?: string | ConversationContentPart[]
  toolCallId?: string
  toolName?: string
  tool_kind?: 'memory' | 'rag' | 'todo'
  result?: unknown
  isError?: boolean
  [key: string]: unknown
}

// server.ts ConversationEntry。按时间和稳定 id 排序。
export interface ConversationEntry {
  work_id?: string
  // 条目所属 Session 的员工 ID，委派输入中为目标员工；姓名由本地目录解析。
  participant_employee_id?: string
  entry_ref?: string
  id: string
  type: string
  parentId?: string | null
  timestamp?: string | number
  message?: ConversationMessage
  logical_message_id?: string
  source_type?: 'human' | 'employee'
  source_id?: string
  source_display_name?: string
  source_employee_id?: string
  source_employee_display_name?: string
  source_role?: 'human' | 'child' | 'participant' | 'coordinator'
  [key: string]: unknown
}

// -------------------- SSE 事件 --------------------

// server.ts PiSseAssistantMessageEvent。type 前缀决定要触发 text/thinking/toolcall 中哪一路。
export type PiAssistantEventType =
  | 'start'
  | 'text_start'
  | 'text_delta'
  | 'text_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'toolcall_start'
  | 'toolcall_delta'
  | 'toolcall_end'
  | 'done'
  | 'error'

export interface PiSseToolCall {
  type?: 'toolCall' | 'tool_call' | 'toolUse' | 'tool_use'
  id?: string
  name?: string
  arguments?: unknown
}

export interface PiSseAssistantMessageEvent {
  type: PiAssistantEventType
  contentIndex?: number
  delta?: string
  content?: string
  reason?: 'stop' | 'length' | 'toolUse' | 'deferred' | 'aborted' | 'error'
  toolCall?: PiSseToolCall
  [key: string]: unknown
}

// server.ts PiSseEventData。顶层 type 决定 event 类别。
export type PiSseEventType =
  | 'agent_start'
  | 'agent_end'
  | 'agent_settled'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'auto_retry_start'
  | 'auto_retry_end'
  | 'compaction_start'
  | 'compaction_end'
  | 'approval_required'

export interface PiSseEventData {
  work_id?: string
  type: PiSseEventType
  conversation_id?: string
  source_ref?: string
  tool_call_id?: string
  // 群聊 fan-out 关键字段:按此 id 分流每个专家的 Pi session 终态。
  source_employee_id?: string
  source_employee_display_name?: string
  source_role?: 'human' | 'child' | 'participant' | 'coordinator'
  message?: ConversationMessage
  assistantMessageEvent?: PiSseAssistantMessageEvent
  toolCallId?: string
  toolName?: string
  tool_kind?: 'memory' | 'rag' | 'todo'
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  message_count?: number
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
  success?: boolean
  finalError?: string
  reason?:
    | 'manual'
    | 'threshold'
    | 'overflow'
    | 'stop'
    | 'length'
    | 'toolUse'
    | 'deferred'
    | 'aborted'
    | 'error'
  aborted?: boolean
  willRetry?: boolean
  [key: string]: unknown
}

/**
 * SSE connected-fence 对账负载。
 *
 * entries 是已经落盘的历史；active_runs 是 Agent 当前仍在生成的消息
 * 快照，允许客户端在切换会话或重连后恢复 thinking/tool 状态，而不依赖
 * 之前那条浏览器内的瞬时 delta 缓存。schema_version 兼容 Agent 现有的
 * v1，以及加入 active_runs/facts 后的 v2。
 */
export interface ConversationActiveRun {
  work_id?: string
  source_employee_id?: string
  source_employee_display_name?: string
  source_role?: 'human' | 'child' | 'participant' | 'coordinator'
  status?: 'thinking' | 'tool' | 'text' | 'waiting' | 'error'
  message?: ConversationMessage
  [key: string]: unknown
}

export interface ConversationFactsState {
  status: 'disabled' | 'idle' | 'queued' | 'flushing' | 'synced' | 'failed' | string
  pending_count?: number
  last_error_code?: string | null
  updated_at?: string | null
  [key: string]: unknown
}

export interface ConversationReconciliation {
  schema_version: '1' | '2' | string
  type: 'reconciliation'
  conversation_id: string
  state: ConversationStateValue
  prompting: boolean
  entries: ConversationEntry[]
  active_runs?: ConversationActiveRun[]
  facts?: ConversationFactsState
  receipt_settlement_pending?: boolean
  overflowed?: boolean
  terminal_overflowed?: boolean
  receipts?: Array<{
    idempotency_key: string
    state: string
    last_entry_id: string | null
    failure_code: string | null
    failure_detail: string | null
  }>
}

// -------------------- Prompt --------------------

// server.ts PromptImage。base64 内联,单张 ≤5 MiB。
export interface PromptImage {
  type: 'image'
  data: string
  mimeType: string
}

// POST /conversations/:id/prompt 请求体。
// text 必填,mentions 仅群聊,attachment_ids 引用先前上传的本地附件。
export interface PromptRequest {
  text: string
  images?: PromptImage[]
  attachment_ids?: string[]
  mentions?: string[]
}

// 202 响应体。state='completed' 表示同 Idempotency-Key 已完成幂等重放。
export interface PromptAccepted {
  conversation_id: string
  accepted: true
  state: 'accepted' | 'completed'
  idempotency_key: string
}

// -------------------- Abort --------------------

export interface AbortResult {
  conversation_id: string
  aborted: boolean
}

// -------------------- Experts(员工列表) --------------------

// server.ts AgentModelPolicy。凭据不下发。
export interface AgentModelPolicy {
  model?: string
  provider_ref?: string
  thinking_level?: ThinkingLevel
}

// server.ts ExpertProjection。会话入口员工从这里选。
// 注意:无 conversation_id 字段,员工→会话映射由 conversations 列表反查。
export interface ExpertProjection {
  availability_reason?: string
  availability_revision?: string
  role_title?: string | null
  department_ids?: string[]
  employee_id: string
  tenant_id: string
  member_id?: string
  version: string
  handle: string
  display_name: string
  revoked: boolean
  synced_at: string
  model_policy?: AgentModelPolicy
  execution_policy?: Record<string, unknown>
  tools: string[]
  skills: string[]
  skill_refs?: string[]
  /** 技能展示名；旧版 Agent 不返回，display_name 为 null 表示本机技能包缓存缺失。 */
  skill_details?: { ref: string; display_name: string | null }[]
  knowledge_refs?: string[]
  connector_refs?: string[]
  memory_policy?: Record<string, unknown>
  persona?: string
  status?: string
  avatar_url?: string | null
  online_status?: string | null
  last_seen_at?: string | null
  /** 招募来源模板；旧缓存可能缺字段，缺失或为 null 时按招募记录回退。 */
  source_template_id?: string | null
  /** 模板版本（string），与员工配置 version 无关。 */
  source_template_version?: string | null
  [key: string]: unknown
}

// server.ts SolutionProjection。群聊没有独立 members 接口，关联方案的
// expert_employee_ids 是当前 Agent API 唯一可读取、可随会话持久化的真实 roster。
export interface SolutionProjection {
  solution_instance_id: string
  solution_id?: string
  display_name: string
  description?: string
  icon?: string
  tags?: string[]
  version: string
  status?: string
  coordinator_instructions?: string
  workflow_skill_ref?: Record<string, unknown>
  output_requirements?: string
  config_version?: number
  coordinator_employee_id?: string | null
  expert_employee_ids?: string[]
  tenant_id?: string
  member_id?: string
  [key: string]: unknown
}

// -------------------- 本地附件 / 产物 --------------------

export interface LocalFileUploadRequest {
  filename: string
  mime_type: string
  data: string // base64,单文件 ≤5 MiB
}

// -------------------- Office 场景 / 动态 --------------------

// server.ts OfficeSceneEnvelope.data.employees[]
export interface OfficeSceneEmployee {
  role_title: string | null
  department_ids: string[]
  employee_id: string
  display_name: string
  status: 'working' | 'ready' | 'offline' | string
  task: string | null
  avatar_url: string | null
  last_activity_at?: string | null
  last_status?: 'working' | 'completed' | 'waiting' | 'error' | 'idle' | 'offline' | string
  last_task?: string | null
}

export interface OfficeSceneSummary {
  total: number
  working: number
  ready: number
  offline: number
}

export interface OfficeScene {
  employees: OfficeSceneEmployee[]
  summary: OfficeSceneSummary
}

// server.ts OfficeFeedEnvelope.data.events[]
export interface OfficeFeedEvent {
  type: 'conversation_schedule' | string
  conversation_id: string
  title: string
  schedule: ConversationSchedule | null
}

export interface OfficeFeed {
  events: OfficeFeedEvent[]
}

// -------------------- 组织树 --------------------

// server.ts OrgTreeNode（递归结构）
export interface OrgTreeNode {
  role_title?: string | null
  id: string
  name: string
  type: 'department' | 'employee'
  parent_id?: string | null
  status?: string | null
  avatar_url?: string | null
  online_status?: string | null
  last_seen_at?: string | null
  children: OrgTreeNode[]
}

// -------------------- 语音转写 --------------------

export interface AudioTranscriptionRequest {
  filename: string
  mime_type: string
  data: string // base64
}

export interface AudioTranscriptionResult {
  text: string
  duration?: number
}

// -------------------- 人才市场模板 --------------------

export type MarketplaceOutputType = 'document' | 'spreadsheet' | 'code' | 'presentation' | 'system_operation'
export type MarketplacePricingMode = 'per_call' | 'per_token' | 'subscription'

export type MarketplaceBillingPeriod = 'month' | 'year'

export interface MarketplaceTemplatePricing {
  mode: MarketplacePricingMode
  /** 十进制字符串；per_token 为每百万 Token 单价。 */
  unit_price: string
  currency: 'USD'
  /** 套餐周期，仅 subscription 有；旧版 Agent / Manager 不返回。 */
  billing_period?: MarketplaceBillingPeriod
}

/** Manager 按当前企业段落评估汇总；样本不足 min_sample 时 resolution_rate 为 null，不能当 0%。 */
export interface MarketplaceTemplateStats {
  resolution_rate: number | null
  evaluated_segments: number
  resolved_segments: number
  min_sample: number
}

// server.ts MarketplaceTemplate($id: "MarketplaceTemplate")。
// 与旧 hermes talent-market 的字段结构完全不同,前端要在 TalentMarket normalizer 做映射。
// tagline 起的展示字段（议题 7）由 FredServer 7c97697f 投影；旧版随包 Agent 不返回，全部按可缺省处理。
export interface MarketplaceTemplate {
  description?: string | null
  // display_name / summary 由本机 Agent 从 Manager 技能市场补齐；技能市场不可用或技能未发布时为 null。
  platform_skill_refs?: { skill_id: string; version: string; content_hash: string; display_name?: string | null; summary?: string | null }[] | null
  template_id: string
  display_name: string
  category: string
  model_name: string       // 可能为空字符串
  skills_count: number
  // 服务端 schema 声明为 number，但未完成统计的模板当前可能返回 null。
  recruit_count: number | null
  is_recruited: boolean
  tags: string[]
  avatar_url: string | null
  tagline?: string | null
  use_cases?: string[]
  limitations?: string[]
  example_prompts?: string[]
  sample_outputs?: { title: string; output_type: MarketplaceOutputType; preview_url: string | null }[]
  output_types?: MarketplaceOutputType[]
  required_connectors?: string[]
  optional_connectors?: string[]
  recommended_knowledge?: string[]
  required_permissions?: { full_access: boolean; local_directories: boolean } | null
  pricing?: MarketplaceTemplatePricing | null
  memory_policy_summary?: string | null
  publisher?: string | null
  version?: string | null
  updated_at?: string | null
  changelog_url?: string | null
  stats?: MarketplaceTemplateStats | null
}

// -------------------- 本地附件 / 产物 --------------------

export interface LocalFileMetadata {
  id: string
  conversation_id: string
  tenant_id: string
  member_id: string
  kind: 'attachment' | 'artifact'
  filename: string
  mime_type: string
  byte_size: number
  sha256: string
  created_at: string
  referenced_at?: string | null
}
