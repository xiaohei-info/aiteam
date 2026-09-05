import { Type } from "typebox";

const employee = Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "仅此数字员工的本机工作/用量；撤权后 owner 历史仍可读。" }));
const range = {
  window_start: Type.Optional(Type.String({ format: "date-time", description: "成对提供 UTC ISO 时间的包含起点；统计必须 UTC 整点，工作历史保持精确时间。" })),
  window_end: Type.Optional(Type.String({ format: "date-time", description: "成对提供 UTC ISO 时间的不包含终点；必须 start < end；均省略表示全部。" })),
};
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50, description: "返回条数，默认 50、最大 100。" }));
const cursor = (description: string) => Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description }));
export const WorkHistoryQuery = Type.Object({ employee_id: employee, ...range, limit, before: cursor("上一页 page.next_cursor，向更早历史翻页；绑定 owner/employee/时间筛选，不是 after 或 entry_ref。") }, { additionalProperties: false });
export const WorkChangesQuery = Type.Object({ employee_id: employee, limit, after: cursor("history.meta.after 或上次 changes.page.next_cursor；绑定 owner/employee，从该水位之后读更新。省略从起点消费。") }, { additionalProperties: false });
export const UsageStatisticsQuery = Type.Object({ employee_id: employee, ...range }, { additionalProperties: false });
const nullableText = (description: string, maxLength?: number) => Type.Union([Type.String({ ...(maxLength ? { maxLength } : {}) }), Type.Null()], { description });
const date = (description: string) => Type.Union([Type.String({ format: "date-time" }), Type.Null()], { description });
const count = (description: string) => Type.Integer({ minimum: 0, description });
const money = (description: string) => Type.String({ pattern: "^\\d+\\.\\d{12}$", description });
const WorkUsage = Type.Object({
  input_tokens: count("Pi 观测输入 token。"), output_tokens: count("Pi 观测输出 token。"), cache_tokens: count("Pi cache read + write token。"), token_total: count("输入、输出与 cache 合计，不使用上游费用字段。"),
  cost_total: Type.Union([money("USD 十二位小数。"), Type.Null()], { description: "固定快照计价的本次费用；缺失价格或非 USD 为 null，不假装零。" }),
  currency: Type.Literal("USD", { description: "唯一受支持计价币种，不跨币种相加。" }),
  pricing_status: Type.String({ enum: ["known", "unknown"], description: "known 需要有效 USD 快照价格与完整 Pi counters。" }),
  pricing_version: Type.Union([Type.Integer(), Type.Null()], { description: "冻结价格版本；不存在为 null。" }),
}, { $id: "WorkUsage", additionalProperties: false, description: "本机观测的每次执行用量；历史 backfill、崩溃未结算、无 counters/初始化失败时整个 usage 为 null。" });
const WorkRecord = Type.Object({
  id: Type.String({ description: "opaque 执行观察 ID；UI upsert/delete 主键，不是 Run/Task ID。" }),
  employee_id: Type.String({ description: "实际执行的 participant 员工，不是发送该输入的员工。" }),
  employee_display_name: Type.String({ maxLength: 256, description: "安全员工展示名。" }),
  conversation_id: Type.String({ description: "当前 owner 的本机会话。" }),
  conversation_title: nullableText("安全会话标题；无值为 null。", 200),
  provenance: Type.String({ enum: ["live", "pi_history"], description: "live 为宿主实际捕获；pi_history 为旧 Pi 消息区间重建，不重新计量。" }),
  outcome: Type.String({ enum: ["active", "succeeded", "error", "aborted", "unknown"], description: "只读观测结果，不控制执行；resolve-abort 仍是 aborted，无可确认终态为 unknown。" }),
  reason: Type.Union([Type.Literal("process_restart"), Type.Null()], { description: "重启发现未确认结果为 process_restart；不是成功，也不重放。" }),
  time_basis: Type.String({ enum: ["prompt_start", "pi_entry", "unknown"], description: "occurred_at 的事实来源；旧 Pi entry 时间不等于 prompt 起止。" }),
  occurred_at: date("历史排序和精确范围筛选使用的真实时间；旧无有效时间为 null，排最后，时间筛选时排除。"),
  started_at: date("宿主实际 promptParticipant 开始；旧历史为 null，不虚构分钟精度。"),
  ended_at: date("宿主实际观测结束；active、崩溃恢复、旧历史为 null。"),
  updated_at: Type.String({ format: "date-time", description: "本地索引观测更新时间；不得以它代替 changes cursor。" }),
  first_entry_at: date("实际首 Pi entry 时间；没有 entry/时间为 null。"), last_entry_at: date("实际末 Pi entry 时间；不冒充 settle 时间。"),
  input_entry_ref: nullableText("输入的稳定 Pi 引用，可用于 entries?entry_ref；没有输入或原条目身份与区间不符时 null。"),
  output_entry_ref: nullableText("末条 assistant 的稳定 Pi 引用；没有响应或原条目身份与区间不符时 null。"),
  source_type: Type.Union([Type.String({ enum: ["human", "employee"] }), Type.Null()], { description: "Stage 1 来源索引的实际发送者类型；缺失旧索引不猜测。" }),
  source_id: nullableText("Stage 1 来源索引发送者 ID；无索引为 null。"),
  task_summary: nullableText("从 Pi 输入完整脱敏后截取的任务短摘要；不持久化第二正文副本，原条目不可定位时 null。", 240),
  result_summary: nullableText("从 Pi 末 assistant 可见内容完整脱敏后截取，排除 thinking/tool；原条目不可定位时 null。", 240),
  usage: Type.Union([Type.Ref("WorkUsage"), Type.Null()], { description: "本次执行已确认 counters/价格；旧历史、faux、崩溃、缺失 counters 时 null，绝不分摊小时总量。" }),
}, { $id: "WorkRecord", additionalProperties: false, description: "当前成员本机每个员工的一次实际 prompt 观测/明确 provenance 的历史片段，不是新的执行引擎。" });
const WorkHistoryEnvelope = Type.Object({ data: Type.Array(Type.Ref("WorkRecord")), page: Type.Ref("Page"), meta: Type.Object({
  after: Type.String({ description: "第一页前的变更水位，后续 before 页保持此值。历史加载后用相同 employee scope 轮询，捕获已看到的 active→final。" }),
}, { additionalProperties: false }) }, { $id: "WorkHistoryEnvelope", description: "(occurred_at DESC,稳定创建序号 DESC) 历史，keyset 非内容快照。" });
const WorkChange = Type.Union([
  Type.Object({ operation: Type.Literal("upsert", { description: "以 record.id 替换/新增本地 UI 项。" }), record_id: Type.String({ description: "工作观察 ID。" }), record: Type.Ref("WorkRecord") }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("delete", { description: "删除本地 UI 中该 ID 项；不返回任何会话/entry/标题/正文引用。" }), record_id: Type.String({ description: "已删除项 opaque ID。" }) }, { additionalProperties: false }),
], { $id: "WorkChange", description: "同 ID 可多次返回最新 upsert；不保证回放每个中间态，保证最新状态不被 created_at 分页漏掉。" });
const WorkChangesEnvelope = Type.Object({ data: Type.Array(Type.Ref("WorkChange")), page: Type.Object({
  next_cursor: Type.String({ description: "始终可继续轮询的 after（空页也保留）；has_more 时立即续页，否则稍后再取。" }),
  has_more: Type.Boolean({ description: "当前还有未消费的变更。" }),
}, { additionalProperties: false }) }, { $id: "WorkChangesEnvelope", description: "单调 change sequence 正序；仅 owner/employee 过滤，删除 tombstone 不留时间/会话信息。" });
const Statistics = Type.Object({
  scope: Type.Literal("member_local", { description: "当前认证成员、本机数据，不是企业/平台全量。" }),
  coverage: Type.Literal("recorded_hourly_summaries", { description: "仅真实保留的小时摘要；不补造旧缺失数据，不包含重建历史或崩溃未结算；旧计数/价格精度按原摘要保留。" }),
  employee_id: nullableText("员工筛选；未筛选为 null。"), window_start: date("包含 UTC 整点起点；未筛选为 null。"), window_end: date("不包含 UTC 整点终点；未筛选为 null。"),
  bucket: Type.Literal("utc_hour", { description: "按执行开始所在 UTC 小时归属。精确分钟范围请查 work-records，不接受非整点统计。" }),
  execution_count: count("摘要中的员工 prompt 执行次数，不是用户业务任务数，也不是 HTTP 接收次数。"), succeeded_count: count("摘要已记录的成功次数；旧摘要不反推修正历史结果。"), non_success_count: count("摘要中的非成功次数（包含 error/abort/unknown），不伪造历史细分。"),
  input_tokens: count("保留摘要输入 token。"), output_tokens: count("保留摘要输出 token。"), cache_tokens: count("保留摘要 cache token。"), token_total: count("保留摘要 token 合计。"), duration_ms_total: count("保留摘要 duration 合计。"),
  currency: Type.Literal("USD", { description: "只相加 USD；异常币种摘要排除并显式计数。" }),
  cost_total: Type.Union([money("最终费用。"), Type.Null()], { description: "仅所有选中摘要均可计价时有值；未知/损坏摘要存在时 null，不宣称为零。" }),
  known_cost_total: money("已知价格摘要小计，十二位 USD decimal；旧已舍去精度无法恢复，不使用逐项 cents 累加。"),
  cost_minor: Type.Union([count("最终 USD cents。"), Type.Null()], { description: "从最终已知总费用一次舍入；未知时 null。优先用 cost_total。" }),
  pricing_status: Type.String({ enum: ["known", "partial", "unknown"], description: "所有已知/部分已知/无已知计价。" }),
  unpriced_execution_count: count("未知定价或缺失完整计量的摘要执行次数。"), excluded_summary_count: count("损坏、非 USD、身份不符等不能安全使用的 owner 摘要行数；不能静默当零。"),
}, { $id: "UsageStatistics", additionalProperties: false, description: "直接汇总全部 pending/sending/sent/failed 小时 outbox。上传成功、会话删除不缩水，无第二账本。" });
const StatisticsEnvelope = Type.Object({ data: Type.Ref("UsageStatistics") }, { $id: "UsageStatisticsEnvelope", description: "成员本机小时统计。" });

export const WORK_RECORD_SCHEMAS = [WorkUsage, WorkRecord, WorkHistoryEnvelope, WorkChange, WorkChangesEnvelope, Statistics, StatisticsEnvelope];
const recordExample = { id: "opaque-execution-id", employee_id: "employee-1", employee_display_name: "研究员", conversation_id: "conversation-1", conversation_title: "总结", provenance: "live", outcome: "active", reason: null, time_basis: "prompt_start", occurred_at: "2026-09-05T08:01:02.123Z", started_at: "2026-09-05T08:01:02.123Z", ended_at: null, updated_at: "2026-09-05T08:01:02.123Z", first_entry_at: null, last_entry_at: null, input_entry_ref: null, output_entry_ref: null, source_type: null, source_id: null, task_summary: null, result_summary: null, usage: null };
const requestExamples = {
  employee_id: { summary: "员工", value: "employee-1" }, window_start: { summary: "UTC 起点", value: "2026-09-05T08:00:00Z" }, window_end: { summary: "UTC 终点", value: "2026-09-05T09:00:00Z" },
  before: { summary: "上页 next_cursor", value: "page_v1.opaque" }, after: { summary: "history.meta.after 或上次 changes.page.next_cursor", value: "page_v1.opaque" }, limit: { summary: "页大小", value: 50 },
};
export const WORK_RECORD_DOCS = {
  listWorkRecords: { request: requestExamples, responses: { "200": { description: "精确历史与初始变更水位；不创建/调用 Pi Session。", examples: { active: { summary: "实际执行尚未结算", value: { data: [recordExample], page: { next_cursor: null, has_more: false }, meta: { after: "page_v1.opaque" } } } } } } },
  listWorkRecordChanges: { request: requestExamples, responses: { "200": { description: "最新 upsert/delete；空页也返回可继续轮询的 next_cursor。", examples: { deleted: { summary: "会话删除后 UI 清除", value: { data: [{ operation: "delete", record_id: "opaque-execution-id" }], page: { next_cursor: "page_v1.opaque", has_more: false } } } } } } },
  getUsageStatistics: { request: requestExamples, responses: { "200": { description: "全部 outbox 状态的小时统计；未知总费用为 null。", examples: { unknown: { summary: "未定价不冒充免费", value: { data: { scope: "member_local", coverage: "recorded_hourly_summaries", employee_id: null, window_start: null, window_end: null, bucket: "utc_hour", execution_count: 1, succeeded_count: 1, non_success_count: 0, input_tokens: 10, output_tokens: 5, cache_tokens: 0, token_total: 15, duration_ms_total: 1234, currency: "USD", cost_total: null, known_cost_total: "0.000000000000", cost_minor: null, pricing_status: "unknown", unpriced_execution_count: 1, excluded_summary_count: 0 } } } } } } },
};
