import { Type, type TProperties, type TSchema } from "typebox";
import type { Router } from "./local-directories.js";
import type { AuthenticatedCaller } from "./auth.js";
import { readPageLimit, validateReadQuery } from "../services/conversation-reads.js";
import {
  ManagerAuthorizationError, ManagerPolicyDeniedError, ManagerUnavailableError, ManagerValidationError,
  type ManagerClient, type MemoryScope,
} from "../manager-client.js";

/**
 * Employee memory lives in the Manager-owned Hindsight bank shared by every member of the
 * employee. The Agent only forwards with the member's own token: Manager stamps contributors at
 * retain time and limits members to what they contributed. Nothing is cached locally.
 */

export const MAX_MEMORY_KEYWORD_CHARS = 1024;
const MAX_MEMORY_OFFSET = 100_000;
const CURSOR_PREFIX = "memory_v1.";
const MEMORY_UNAVAILABLE_CODES = new Set(["hindsight_unavailable", "memory_retention_unverified"]);

export class EmployeeMemoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "EmployeeMemoryError";
  }
}

const str = (description: string, options: Record<string, unknown> = {}) => Type.String({ description, ...options });
const obj = <T extends TProperties>(properties: T, description: string) => Type.Object(properties, { additionalProperties: false, description });
const nullable = (schema: TSchema, description: string) => Type.Union([schema, Type.Null()], { description });
const count = (description: string) => Type.Integer({ minimum: 0, description });
const ScopeSchema = Type.String({ enum: ["mine", "all"], description: "mine 只看自己贡献的；all 看全部，仅企业 owner/管理员生效，普通成员一律按 mine。" });

export const EmployeeMemorySchema = obj({
  memory_id: str("记忆 ID。"),
  employee_id: str("员工 ID。"),
  content: str("记忆正文。"),
  category: str("Hindsight 原始分类值（如 world、experience）；前端不猜中文名。"),
  importance: nullable(Type.Number({ description: "重要度" }), "重要度 0–1；未知为 null。"),
  source: str("写入来源，如 context_reset。"),
  created_at: nullable(str("写入时间"), "写入时间；未知为 null。"),
  last_used_at: nullable(str("最近被用到的时间"), "最近被用到的时间；未知为 null。"),
  state: Type.String({ enum: ["valid", "invalidated"], description: "valid 有效 / invalidated 已失效。" }),
  contributor_member_id: nullable(str("贡献成员 ID"), "Manager 在保存时按登录身份写入；功能上线前的历史记忆为 null（来源未知，仅管理员可见）。"),
  contributor_display_name: nullable(str("贡献成员显示名"), "贡献成员显示名；查不到时为 null。"),
  is_mine: Type.Boolean({ description: "是否由当前成员贡献；普通成员只能删除自己贡献的记忆。" }),
}, "员工的一条长期记忆；由 Manager 按成员范围过滤后返回。");

const MemoryListMeta = obj({
  scope: ScopeSchema,
  total: count("当前范围内的记忆总数。"),
  truncated: Type.Boolean({ description: "记忆超过 Manager 扫描上限时为 true，total 只覆盖已扫描部分。" }),
}, "实际生效的范围与总数。");

export const EmployeeMemorySummarySchema = obj({
  employee_id: str("员工 ID。"),
  scope: ScopeSchema,
  total_count: count("当前范围内的有效记忆条数。"),
  own_count: count("当前成员贡献的有效记忆条数。"),
  others_count: count("其他成员贡献的有效记忆条数；只有数量，没有内容。"),
  unattributed_count: count("来源未知的历史记忆条数；内容仅企业管理员可见。"),
  recent_count: count("当前范围内近 7 天新增条数。"),
  latest_used_at: nullable(str("时间"), "当前范围内最近一次被用到的时间；未知为 null。"),
  truncated: Type.Boolean({ description: "记忆超过扫描上限时为 true。" }),
}, "按贡献者统计的记忆条数，不含任何记忆正文。");

const Page = obj({
  next_cursor: nullable(str("下一页游标", { minLength: 1 }), "下一页游标；末页为 null。"),
  has_more: Type.Boolean({ description: "是否还有更多。" }),
}, "分页信息。");

const MemoryParams = obj({ employee_id: str("授权员工 ID。", { minLength: 1 }) }, "员工路径参数");
const MemoryItemParams = obj({
  employee_id: str("授权员工 ID。", { minLength: 1 }),
  memory_id: str("记忆 ID。", { minLength: 1, maxLength: 256 }),
}, "记忆路径参数");
const ListQuery = obj({
  scope: Type.Optional(ScopeSchema),
  keyword: Type.Optional(str("按正文搜索。", { minLength: 1, maxLength: MAX_MEMORY_KEYWORD_CHARS })),
  cursor: Type.Optional(str("上一页返回的 next_cursor。", { minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每页条数，默认 50。" })),
}, "记忆列表筛选");
const SummaryQuery = obj({ scope: Type.Optional(ScopeSchema) }, "统计范围");

const json = (schema: TSchema) => ({ content: { "application/json": { schema } } });
const problem = (description: string) => ({ content: { "application/problem+json": { schema: Type.Ref("Problem") } }, description });
const errors = { 401: problem("Unauthorized"), 403: problem("Forbidden"), 404: problem("NotFound"), 422: problem("ValidationError"), 503: problem("ManagerUnavailable") };

function invalid(code: string, detail: string): never {
  throw new EmployeeMemoryError(422, code, detail);
}

function readScope(query: URLSearchParams): MemoryScope | undefined {
  const scope = query.get("scope");
  if (scope === null) return undefined;
  if (scope !== "mine" && scope !== "all") invalid("invalid_scope", "scope must be mine or all");
  return scope;
}

export function encodeMemoryCursor(offset: number): string {
  return CURSOR_PREFIX + Buffer.from(String(offset)).toString("base64url");
}

export function decodeMemoryCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const raw = cursor.startsWith(CURSOR_PREFIX) ? Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString() : "";
  const offset = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > MAX_MEMORY_OFFSET) invalid("invalid_cursor", "cursor is invalid");
  return offset;
}

/** Keep Manager's code where the UI needs it: not-yours, memory disabled/ungranted, memory service down. */
export function employeeMemoryProblem(error: unknown): Error {
  if (error instanceof ManagerAuthorizationError) {
    if (error.status === 401) return new EmployeeMemoryError(401, "unauthenticated", "Manager authentication is required");
    if (error.problemCode === "memory_not_contributor") return new EmployeeMemoryError(403, "memory_not_contributor", "Members can only delete memories they contributed");
    return new EmployeeMemoryError(403, "memory_forbidden", "Memory is not enabled for this employee or the member is not authorized");
  }
  if (error instanceof ManagerPolicyDeniedError) return new EmployeeMemoryError(404, "memory_employee_not_found", "Employee is not available in Manager");
  if (error instanceof ManagerValidationError) return new EmployeeMemoryError(422, "memory_invalid_request", "Manager rejected the memory request");
  if (error instanceof ManagerUnavailableError) {
    return error.problemCode && MEMORY_UNAVAILABLE_CODES.has(error.problemCode)
      ? new EmployeeMemoryError(503, "memory_unavailable", "Memory service is unavailable")
      : new EmployeeMemoryError(503, "manager_unavailable", "Manager is unavailable");
  }
  return error instanceof Error ? error : new Error("Employee memory request failed");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse each Manager item at the boundary; an unreadable item means an unreadable page. */
function projectMemory(value: unknown): Record<string, unknown> {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw || typeof raw.memory_id !== "string" || typeof raw.employee_id !== "string" || typeof raw.content !== "string"
    || typeof raw.category !== "string" || typeof raw.source !== "string") {
    throw new ManagerUnavailableError("Manager returned an invalid memory item");
  }
  return {
    memory_id: raw.memory_id, employee_id: raw.employee_id, content: raw.content, category: raw.category,
    importance: typeof raw.importance === "number" && Number.isFinite(raw.importance) ? raw.importance : null,
    source: raw.source, created_at: nullableString(raw.created_at), last_used_at: nullableString(raw.last_used_at),
    state: raw.state === "invalidated" ? "invalidated" : "valid",
    contributor_member_id: nullableString(raw.contributor_member_id),
    contributor_display_name: nullableString(raw.contributor_display_name),
    is_mine: raw.is_mine === true,
  };
}

export function registerEmployeeMemoryRoutes(
  router: Router,
  managerClient: () => ManagerClient | undefined,
  requireAuthorizedEmployee: (employeeId: string, caller: AuthenticatedCaller) => void,
): void {
  const schema = (operationId: string, summary: string, description: string, fields: Record<string, unknown>) => ({
    operationId, summary, description, tags: ["employees"], ...fields,
  });
  const forward = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await call(); } catch (error) { throw employeeMemoryProblem(error); }
  };
  const client = <K extends "memoryList" | "memorySummary" | "memoryDelete">(method: K): NonNullable<ManagerClient[K]> => {
    const value = managerClient()?.[method];
    if (!value) throw new EmployeeMemoryError(503, "manager_unavailable", "Employee memory is unavailable");
    return value.bind(managerClient()) as NonNullable<ManagerClient[K]>;
  };

  router.register("GET", "/api/agent/employees/:employee_id/memories", async (req, res, caller, fastifyRequest) => {
    const { employee_id: employeeId } = fastifyRequest!.params as { employee_id: string };
    requireAuthorizedEmployee(employeeId, caller!);
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    validateReadQuery(query, ["scope", "keyword", "cursor", "limit"]);
    const scope = readScope(query);
    const keyword = query.get("keyword")?.trim() || undefined;
    if (keyword && [...keyword].length > MAX_MEMORY_KEYWORD_CHARS) invalid("invalid_keyword", `keyword must be at most ${MAX_MEMORY_KEYWORD_CHARS} characters`);
    const limit = readPageLimit(query);
    const offset = decodeMemoryCursor(query.get("cursor"));
    const list = client("memoryList");
    const page = await forward(() => list(caller!, employeeId, { scope, keyword, limit, offset }));
    const items = await forward(async () => page.items.map(projectMemory));
    const hasMore = offset + limit < page.total;
    router.send(res, 200, {
      data: items,
      page: { next_cursor: hasMore ? encodeMemoryCursor(offset + limit) : null, has_more: hasMore },
      meta: { scope: page.scope, total: page.total, truncated: page.truncated },
    });
  }, schema("listEmployeeMemories", "列出员工记忆",
    "转发到 Manager，用当前成员的登录身份读取该员工的长期记忆。记忆存放在 Manager 侧当前企业该员工的 Hindsight bank，成员共享；Agent 不缓存、不落库。普通成员只能看到自己贡献的有效记忆，scope=all 对其无效；企业 owner/管理员不传 scope 时看全部（含来源未知的历史记忆）。员工须已授权给当前成员。",
    { params: MemoryParams, querystring: ListQuery, response: { 200: json(obj({ data: Type.Array(EmployeeMemorySchema, { description: "按 Manager 顺序排列的记忆。" }), page: Page, meta: MemoryListMeta }, "记忆列表")), ...errors } }));

  router.register("GET", "/api/agent/employees/:employee_id/memories/summary", async (req, res, caller, fastifyRequest) => {
    const { employee_id: employeeId } = fastifyRequest!.params as { employee_id: string };
    requireAuthorizedEmployee(employeeId, caller!);
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    validateReadQuery(query, ["scope"]);
    const scope = readScope(query);
    const summary = client("memorySummary");
    router.send(res, 200, { data: await forward(() => summary(caller!, employeeId, scope)) });
  }, schema("getEmployeeMemorySummary", "读取员工记忆条数摘要",
    "转发到 Manager，按贡献者统计该员工在当前企业的有效记忆条数，不含任何记忆正文。普通成员可据此显示「另有 N 条来自其他成员」和「来源未知 N 条」，但看不到内容。员工须已授权给当前成员。",
    { params: MemoryParams, querystring: SummaryQuery, response: { 200: json(obj({ data: EmployeeMemorySummarySchema }, "记忆摘要")), ...errors } }));

  router.register("DELETE", "/api/agent/employees/:employee_id/memories/:memory_id", async (_req, res, caller, fastifyRequest) => {
    const { employee_id: employeeId, memory_id: memoryId } = fastifyRequest!.params as { employee_id: string; memory_id: string };
    requireAuthorizedEmployee(employeeId, caller!);
    if (memoryId.length > 256) invalid("invalid_memory_id", "memory_id must be at most 256 characters");
    const remove = client("memoryDelete");
    await forward(() => remove(caller!, employeeId, memoryId));
    router.send(res, 200, { data: { deleted: true, employee_id: employeeId, memory_id: memoryId } });
  }, schema("deleteEmployeeMemory", "删除员工记忆",
    "转发到 Manager 删除（使失效）该员工的一条记忆，员工此后不再记得它，不可恢复。普通成员只能删除自己贡献的记忆，否则返回 403 memory_not_contributor；企业 owner/管理员可删除任意记忆。只作用于当前企业该员工的 bank；员工须已授权给当前成员。",
    { params: MemoryItemParams, response: { 200: json(obj({ data: obj({ deleted: Type.Literal(true, { description: "已删除。" }), employee_id: str("员工 ID。"), memory_id: str("记忆 ID。") }, "删除结果") }, "删除响应")), ...errors } }));
}

const exampleMemory = {
  memory_id: "memory-1", employee_id: "employee-1", content: "用户偏好周报用表格形式，按项目分组。", category: "world", importance: 0.75,
  source: "context_reset", created_at: "2026-10-30T02:21:00Z", last_used_at: "2026-10-30T02:21:00Z", state: "valid",
  contributor_member_id: "member-1", contributor_display_name: "张三", is_mine: true,
};

export const EMPLOYEE_MEMORY_PARAMETER_EXAMPLES = { memory_id: exampleMemory.memory_id };

export const EMPLOYEE_MEMORY_OPERATION_DOCS = {
  listEmployeeMemories: {
    request: {
      scope: { summary: "只看我的", value: "mine" }, keyword: { summary: "搜索", value: "周报" },
      cursor: { summary: "下一页", value: encodeMemoryCursor(50) }, limit: { summary: "每页", value: 50 },
    },
    responses: { "200": { description: "当前范围内的一页记忆。", examples: {
      mine: { summary: "成员只看到自己贡献的", value: { data: [exampleMemory], page: { next_cursor: null, has_more: false }, meta: { scope: "mine", total: 1, truncated: false } } },
    } } },
  },
  getEmployeeMemorySummary: {
    request: { scope: { summary: "只看我的", value: "mine" } },
    responses: { "200": { description: "按贡献者统计的条数。", examples: {
      member: { summary: "另有 32 条来自其他成员", value: { data: { employee_id: "employee-1", scope: "mine", total_count: 10, own_count: 10, others_count: 32, unattributed_count: 5, recent_count: 6, latest_used_at: "2026-10-30T02:21:00Z", truncated: false } } },
    } } },
  },
  deleteEmployeeMemory: {
    responses: { "200": { description: "记忆已删除。", examples: {
      deleted: { summary: "已删除", value: { data: { deleted: true, employee_id: "employee-1", memory_id: "memory-1" } } },
    } } },
  },
};
