import { Type, type TProperties, type TSchema } from "typebox";
import type { Router } from "./local-directories.js";
import type { AuthenticatedCaller } from "./auth.js";
import { ConversationReadError, validateReadQuery } from "../services/conversation-reads.js";
import { workReadFilter } from "../services/work-records.js";
import {
  ContextSegmentError, isOutcomeReason, RESOLUTION_RATE_MIN_SAMPLE, SEGMENT_OUTCOME_REASONS,
  type ContextSegmentStore, type SegmentEvaluation, type SegmentOutcome, type SegmentOutcomeReason,
} from "../storage/context-segments.js";

export const MAX_OUTCOME_NOTE_CHARS = 500;
export const EVALUATION_FIELDS = ["outcome", "outcome_reasons", "outcome_note", "follow_up"] as const;

const str = (description: string, options: Record<string, unknown> = {}) => Type.String({ description, ...options });
const obj = <T extends TProperties>(properties: T, description: string) => Type.Object(properties, { additionalProperties: false, description });
const nullable = (schema: TSchema, description: string) => Type.Union([schema, Type.Null()], { description });
const count = (description: string) => Type.Integer({ minimum: 0, description });

const OutcomeSchema = Type.String({ enum: ["resolved", "unresolved"], description: "resolved 已解决 / unresolved 未解决。" });
const ReasonSchema = Type.String({ enum: [...SEGMENT_OUTCOME_REASONS], description: "未解决原因：off_topic 答非所问、missing_info 信息不够、execution_failed 执行失败、wrong_result 结果不对、too_slow 太慢、other 其他。" });
const ReasonsSchema = Type.Array(ReasonSchema, { maxItems: SEGMENT_OUTCOME_REASONS.length, uniqueItems: true, description: "未解决原因；仅 outcome=unresolved 时可填。" });

/** Fields shared by the reset request and the segment PATCH. */
export const SegmentEvaluationProperties = {
  outcome_reasons: Type.Optional(ReasonsSchema),
  outcome_note: Type.Optional(str("成员对结果的备注，可选。", { maxLength: MAX_OUTCOME_NOTE_CHARS })),
  follow_up: Type.Optional(Type.Boolean({ description: "保留为待跟进事项。" })),
};

export const ContextSegmentSchema = obj({
  segment_id: str("段落 ID，等于结束该段的重置 reset_id；会话历史分隔标记携带相同 ID。"),
  conversation_id: str("会话 ID。"),
  employee_ids: Type.Array(str("员工 ID"), { description: "本段被重置的参与员工；群聊评估计入每位员工的解决率。" }),
  message_count: count("重置前本段的用户与 Agent 消息数（群聊取参与者最大值）。"),
  outcome: nullable(OutcomeSchema, "结果评估；null 为未评估，不计入解决率。"),
  outcome_reasons: Type.Array(ReasonSchema, { description: "未解决原因；已解决或未评估时为空。" }),
  outcome_note: nullable(str("备注"), "备注；未填为 null。"),
  follow_up: Type.Boolean({ description: "是否保留为待跟进事项。" }),
  revision: Type.Integer({ minimum: 1, description: "乐观并发版本号；PATCH 时回传。" }),
  ended_at: str("本段结束（重置）时间。", { format: "date-time" }),
  evaluated_at: nullable(str("评估时间", { format: "date-time" }), "最近一次评估时间；未评估为 null。"),
  editable_until: str("可修改评估的截止时间（结束后 7 天）。", { format: "date-time" }),
}, "一段上下文及成员对其结果的评估；不含任何对话正文。");

const OutcomeTotals = {
  evaluated_count: count("已评估段数。"),
  resolved_count: count("已解决段数。"),
  unresolved_count: count("未解决段数。"),
  resolution_rate: nullable(Type.Number({ minimum: 0, maximum: 1 }), `已解决 ÷ 已评估；已评估少于 ${RESOLUTION_RATE_MIN_SAMPLE} 段时为 null，不发布小样本比例。`),
  reasons: Type.Array(obj({ reason: ReasonSchema, count: count("出现次数。") }, "未解决原因计数"), { description: "未解决原因按次数降序。" }),
};
const OutcomeGroup = obj({ employee_id: str("员工 ID。"), ...OutcomeTotals }, "单个员工的解决率；群聊段落计入其中每位员工。");
const OutcomeStatistics = obj({
  scope: Type.Literal("member_local", { description: "当前认证成员、本机评估，不是企业全量。" }),
  employee_id: nullable(str("员工 ID"), "员工筛选；未筛选为 null。"),
  window_start: nullable(str("起点", { format: "date-time" }), "按段落结束时间筛选的包含起点；未筛选为 null。"),
  window_end: nullable(str("终点", { format: "date-time" }), "不包含终点；未筛选为 null。"),
  min_sample: count("发布解决率所需的最少已评估段数。"),
  ...OutcomeTotals,
  groups: Type.Optional(Type.Array(OutcomeGroup, { description: "仅 group_by=employee 时返回；按已评估段数降序。" })),
}, "本机段落评估汇总；未评估的段不进分母。");

const envelope = (schema: TSchema) => obj({ data: schema }, "成功响应");
const json = (schema: TSchema) => ({ content: { "application/json": { schema } } });
const problem = (description: string) => ({ content: { "application/problem+json": { schema: Type.Ref("Problem") } }, description });

const ConversationParams = obj({ conversation_id: str("本地会话 ID。", { minLength: 1 }) }, "会话路径参数");
const SegmentParams = obj({ conversation_id: str("本地会话 ID。", { minLength: 1 }), segment_id: str("段落 ID。", { minLength: 1 }) }, "段落路径参数");
const SegmentPatchBody = obj({
  outcome: nullable(OutcomeSchema, "新的结果评估；null 撤销评估（变回未评估）。"),
  ...SegmentEvaluationProperties,
  revision: Type.Integer({ minimum: 1, description: "读取到的段落 revision；不一致返回 409。" }),
}, "修改或撤销段落评估。");
const OutcomeQuery = obj({
  employee_id: Type.Optional(str("仅此员工参与的段落。", { minLength: 1, maxLength: 256 })),
  window_start: Type.Optional(str("成对提供；按段落结束时间的包含起点（UTC，精确时间）。", { format: "date-time" })),
  window_end: Type.Optional(str("成对提供；不包含终点。", { format: "date-time" })),
  group_by: Type.Optional(Type.Literal("employee", { description: "额外返回按员工分组的 groups[]。" })),
}, "解决率筛选");

export function mapContextSegmentError(error: ContextSegmentError): { status: number; code: string; detail: string } {
  switch (error.code) {
    case "segment_not_found": return { status: 404, code: "segment_not_found", detail: "Context segment was not found" };
    case "revision_conflict": return { status: 409, code: "segment_revision_conflict", detail: "Segment was changed elsewhere; reload the current revision and retry" };
    case "edit_window_closed": return { status: 409, code: "segment_edit_window_closed", detail: "Segment evaluations can only be changed within 7 days of the reset" };
  }
}

function invalid(code: string, detail: string): never {
  throw new ConversationReadError(422, code, detail);
}

/**
 * Reads the evaluation fields of a reset or PATCH body. Reasons belong to an unresolved verdict
 * only, and clearing the verdict (outcome null, PATCH only) drops every detail with it.
 */
export function parseSegmentEvaluation(body: Record<string, unknown>, options: { allowClear: boolean }): SegmentEvaluation | undefined {
  const outcome = body.outcome;
  if (outcome === undefined) {
    if (EVALUATION_FIELDS.some((field) => body[field] !== undefined)) invalid("invalid_outcome", "outcome_reasons, outcome_note and follow_up need an outcome");
    return undefined;
  }
  if (outcome === null ? !options.allowClear : outcome !== "resolved" && outcome !== "unresolved") invalid("invalid_outcome", options.allowClear ? "outcome must be resolved, unresolved or null" : "outcome must be resolved or unresolved");
  const reasons = body.outcome_reasons ?? [];
  if (!Array.isArray(reasons) || !reasons.every(isOutcomeReason) || new Set(reasons).size !== reasons.length) invalid("invalid_outcome_reasons", `outcome_reasons must be distinct values of ${SEGMENT_OUTCOME_REASONS.join(", ")}`);
  if (reasons.length && outcome !== "unresolved") invalid("invalid_outcome_reasons", "outcome_reasons apply to an unresolved outcome only");
  const note = body.outcome_note;
  if (note !== undefined && (typeof note !== "string" || [...note].length > MAX_OUTCOME_NOTE_CHARS)) invalid("invalid_outcome_note", `outcome_note must be a string of at most ${MAX_OUTCOME_NOTE_CHARS} characters`);
  if (body.follow_up !== undefined && typeof body.follow_up !== "boolean") invalid("invalid_follow_up", "follow_up must be a boolean");
  return {
    outcome: outcome as SegmentOutcome | null,
    reasons: reasons as SegmentOutcomeReason[],
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    followUp: body.follow_up === true,
  };
}

function tally(rows: ReadonlyArray<{ outcome: SegmentOutcome; reasons: readonly SegmentOutcomeReason[] }>) {
  const resolved = rows.filter((row) => row.outcome === "resolved").length;
  const reasons = new Map<SegmentOutcomeReason, number>();
  for (const row of rows) for (const reason of row.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  return {
    evaluated_count: rows.length,
    resolved_count: resolved,
    unresolved_count: rows.length - resolved,
    resolution_rate: rows.length >= RESOLUTION_RATE_MIN_SAMPLE ? resolved / rows.length : null,
    reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

function owner(caller: AuthenticatedCaller) {
  return { tenantId: caller.tenantId ?? "", memberId: caller.userId ?? caller.callerId };
}

export function registerContextSegmentRoutes(router: Router, store: ContextSegmentStore, requireOwnedConversation: (conversationId: string, caller: AuthenticatedCaller) => void): void {
  const schema = (operationId: string, summary: string, description: string, response: TSchema, extras: Record<string, unknown> = {}) => ({
    operationId, summary, description, tags: ["conversations"], ...extras,
    response: { 200: json(response), 401: problem("Unauthorized"), 404: problem("NotFound"), 409: problem("Conflict"), 422: problem("ValidationError") },
  });

  router.register("GET", "/api/agent/conversations/:conversation_id/segments", async (_req, res, caller, fastifyRequest) => {
    const { conversation_id: conversationId } = fastifyRequest!.params as { conversation_id: string };
    requireOwnedConversation(conversationId, caller!);
    router.send(res, 200, { data: store.list(owner(caller!), conversationId) });
  }, schema("listConversationSegments", "列出会话的上下文段落与结果评估",
    "每次重置结束一段，按结束时间正序。上线前的旧重置没有段落记录，前端按未评估处理。仅当前成员自己的会话。",
    envelope(Type.Array(ContextSegmentSchema)), { params: ConversationParams }));

  router.register("PATCH", "/api/agent/conversations/:conversation_id/segments/:segment_id", async (req, res, caller, fastifyRequest) => {
    const { conversation_id: conversationId, segment_id: segmentId } = fastifyRequest!.params as { conversation_id: string; segment_id: string };
    requireOwnedConversation(conversationId, caller!);
    const body = await router.read(req);
    for (const key of Object.keys(body)) {
      if (key !== "revision" && !(EVALUATION_FIELDS as readonly string[]).includes(key)) invalid("invalid_request", `Unknown field: ${key}`);
    }
    if (body.outcome === undefined) invalid("invalid_outcome", "outcome is required; use null to clear the evaluation");
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) invalid("invalid_revision", "revision must be a positive integer");
    const evaluation = parseSegmentEvaluation(body, { allowClear: true })!;
    router.send(res, 200, { data: store.evaluate(owner(caller!), conversationId, segmentId, evaluation, body.revision as number) });
  }, schema("updateConversationSegment", "修改或撤销段落评估",
    "改为另一种结果、补充原因与备注，或 outcome=null 撤销评估（重置本身不可撤销）。结束后 7 天内有效，过期返回 409 segment_edit_window_closed；revision 不一致返回 409 segment_revision_conflict。",
    envelope(ContextSegmentSchema), { params: SegmentParams, body: SegmentPatchBody }));

  router.register("GET", "/api/agent/usage/outcomes", async (req, res, caller) => {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    validateReadQuery(query, ["employee_id", "window_start", "window_end", "group_by"]);
    const groupBy = query.get("group_by");
    if (groupBy !== null && groupBy !== "employee") invalid("invalid_group_by", "group_by must be employee");
    const filter = workReadFilter(caller!, query);
    const rows = store.evaluated(filter);
    const byEmployee = new Map<string, typeof rows>();
    if (groupBy !== null) {
      for (const row of rows) for (const employeeId of new Set(row.employeeIds)) {
        if (filter.employeeId && employeeId !== filter.employeeId) continue;
        byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), row]);
      }
    }
    router.send(res, 200, { data: {
      scope: "member_local",
      employee_id: filter.employeeId ?? null,
      window_start: filter.start === undefined ? null : new Date(filter.start).toISOString(),
      window_end: filter.end === undefined ? null : new Date(filter.end).toISOString(),
      min_sample: RESOLUTION_RATE_MIN_SAMPLE,
      ...tally(rows),
      ...(groupBy === null ? {} : {
        groups: [...byEmployee.entries()]
          .map(([employeeId, group]) => ({ employee_id: employeeId, ...tally(group) }))
          .sort((a, b) => b.evaluated_count - a.evaluated_count || a.employee_id.localeCompare(b.employee_id)),
      }),
    } });
  }, schema("getUsageOutcomes", "读取当前成员本机的段落解决率",
    "已解决 ÷（已解决 + 未解决），未评估不进分母；样本少于 10 段时 resolution_rate 为 null。时间窗按段落结束时间精确筛选，不要求整点。群聊段落计入其中每位员工。",
    envelope(OutcomeStatistics), { querystring: OutcomeQuery }));
}

const exampleSegment = {
  segment_id: "0b6f1c9e-2d4a-4f61-9b7e-3c2a1d5e8f90", conversation_id: "conversation-1", employee_ids: ["employee-1"], message_count: 6,
  outcome: "unresolved", outcome_reasons: ["missing_info"], outcome_note: "缺少报价单", follow_up: true, revision: 1,
  ended_at: "2026-10-30T02:00:00.000Z", evaluated_at: "2026-10-30T02:00:00.000Z", editable_until: "2026-11-06T02:00:00.000Z",
};
const exampleTotals = { evaluated_count: 12, resolved_count: 9, unresolved_count: 3, resolution_rate: 0.75, reasons: [{ reason: "missing_info", count: 2 }, { reason: "wrong_result", count: 1 }] };

export const CONTEXT_SEGMENT_PARAMETER_EXAMPLES = { segment_id: exampleSegment.segment_id };

export const CONTEXT_SEGMENT_OPERATION_DOCS = {
  listConversationSegments: { responses: { "200": { description: "会话全部段落，按结束时间正序。", examples: {
    list: { summary: "一段未解决、一段未评估", value: { data: [exampleSegment, { ...exampleSegment, segment_id: "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", outcome: null, outcome_reasons: [], outcome_note: null, follow_up: false, evaluated_at: null }] } },
  } } } },
  updateConversationSegment: {
    request: {
      revise: { summary: "改为已解决", value: { outcome: "resolved", revision: 1 } },
      clear: { summary: "撤销评估", value: { outcome: null, revision: 1 } },
    },
    responses: { "200": { description: "更新后的段落。", examples: {
      revised: { summary: "已改为已解决", value: { data: { ...exampleSegment, outcome: "resolved", outcome_reasons: [], revision: 2 } } },
    } } },
  },
  getUsageOutcomes: {
    request: {
      employee_id: { summary: "员工", value: "employee-1" }, window_start: { summary: "起点", value: "2026-10-23T16:00:00Z" },
      window_end: { summary: "终点", value: "2026-10-30T16:00:00Z" }, group_by: { summary: "按员工分组", value: "employee" },
    },
    responses: { "200": { description: "段落解决率；样本不足时 resolution_rate 为 null。", examples: {
      grouped: { summary: "按员工分组", value: { data: { scope: "member_local", employee_id: null, window_start: null, window_end: null, min_sample: RESOLUTION_RATE_MIN_SAMPLE, ...exampleTotals, groups: [{ employee_id: "employee-1", ...exampleTotals }] } } },
    } } },
  },
};
