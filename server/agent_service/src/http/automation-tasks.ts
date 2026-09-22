import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyRequest } from "fastify";
import { Type, type TSchema, type TProperties } from "typebox";
import type { AuthenticatedCaller } from "./auth.js";
import { AutomationTaskService } from "../services/automation-tasks.js";

const str = (description: string, options: Record<string, unknown> = {}) => Type.String({ description, ...options });
const nullable = (description: string) => Type.Union([str(description), Type.Null()], { description });
const obj = <T extends TProperties>(properties: T, description: string) => Type.Object(properties, { additionalProperties: false, description });
export const CalendarRuleSchema = Type.Union([
  obj({ mode: Type.Literal("daily"), timezone: str("IANA 时区"), time: str("当地 HH:mm:ss") }, "每天，夏令时缺失跳过，重复取较早一次"),
  obj({ mode: Type.Literal("weekly"), timezone: str("IANA 时区"), time: str("当地 HH:mm:ss"), weekday: Type.Integer({ minimum: 1, maximum: 7, description: "ISO 星期" }) }, "每周"),
  obj({ mode: Type.Literal("monthly"), timezone: str("IANA 时区"), time: str("当地 HH:mm:ss"), day_of_month: Type.Integer({ minimum: 1, maximum: 31, description: "每月日期" }), invalid_date_policy: Type.Literal("skip", { description: "不存在日期跳过" }) }, "每月"),
], { description: "日历调度规则" });
const Schedule = Type.Union([
  CalendarRuleSchema,
  obj({ mode: Type.Literal("once"), timezone: str("IANA 时区"), run_at: str("单次执行时间", { format: "date-time" }) }, "单次"),
  obj({ mode: Type.Literal("interval"), timezone: str("IANA 时区"), starts_at: str("间隔锚点", { format: "date-time" }), interval_seconds: Type.Integer({ minimum: 1, description: "秒数；新任务写入最小 300，兼容旧间隔配置" }) }, "固定间隔"),
], { description: "自动化任务计划" });
const Connector = obj({ connector_id: str("授权连接器引用"), display_name: str("连接器名称"), type: Type.Literal("mcp", { description: "能力类型" }), status: str("enabled 表示本地配置及授权就绪，不保证外部网络健康"), available_employee_ids: Type.Array(str("可使用的员工 ID"), { description: "授权员工" }) }, "本地受控连接器，无凭据");
const Run = obj({ run_id: str("触发索引 ID"), conversation_id: str("执行会话 ID"), schedule_id: str("调度 ID"), scheduled_at: str("计划 UTC 时刻", { format: "date-time" }), receipt_key: nullable("执行收据引用"), status: str("运行观察状态，含 unknown"), started_at: nullable("开始时间"), finished_at: nullable("结束时间"), error_code: nullable("安全错误码"), result_summary: nullable("脱敏结果摘要"), work_record_ids: Type.Array(str("工作记录 ID"), { description: "关联工作记录" }) }, "一次调度的只读结果，非独立执行状态机");
const writable = {
  name: str("任务名称", { minLength: 1, maxLength: 120 }), prompt: str("执行指令", { minLength: 1, maxLength: 20_000 }),
  category: Type.Union(["report", "monitor", "reminder", "other"].map(c => Type.Literal(c)), { description: "任务分类" }),
  employee_id: str("授权员工 ID", { minLength: 1 }), connector_ids: Type.Array(str("连接器引用"), { maxItems: 10, uniqueItems: true, description: "任务使用的连接器集合，只能收窄员工授权" }), schedule: Schedule,
};
const Task = obj({ ...writable, name: str("任务名称，旧会话标题最多 200 字符", { maxLength: 200 }), prompt: str("完整指令，兼容旧会话配置", { maxLength: 200_000 }), schedule: Type.Union([Schedule, Type.Null()], { description: "移除调度后为空，需重新配置" }), employee_id: nullable("私聊员工或群聊协调人"),
  task_id: str("任务稳定 ID；兼容旧会话 ID"), prompt_summary: str("截断指令摘要"), employee: Type.Union([obj({ employee_id: str("员工 ID"), display_name: str("名称") }, "员工展示"), Type.Null()], { description: "当前员工展示投影" }),
  connectors: Type.Array(Connector, { description: "已选连接器展示" }), status: str("active/paused/completed"), block_reason: nullable("当前执行阻塞原因"), conversation_id: nullable("当前执行会话"), target_kind: str("private/group"), origin: str("automation/conversation"), etag: str("If-Match 条件版本"),
  last_run_at: nullable("上次开始时间"), last_run: Type.Union([Run, Type.Null()], { description: "最近触发结果" }), next_run_at: nullable("下一次 UTC 计划时间"), created_by: str("成员 ID"), created_at: str("创建时间"), updated_at: str("配置更新时间"),
}, "本地自动化任务与旧会话调度的统一视图");
const ListTask = Type.Omit(Task, ["prompt"]);
const envelope = (schema: TSchema) => obj({ data: schema }, "成功响应");
const list = (schema: TSchema) => obj({ data: Type.Array(schema, { description: "当前页记录" }), page: Type.Ref("Page") }, "分页响应，默认按创建时间和 ID 倒序");
const json = (schema: TSchema) => ({ content: { "application/json": { schema } } });
const problem = (description: string) => ({ content: { "application/problem+json": { schema: Type.Ref("Problem") } }, description });
const params = obj({ task_id: str("任务 ID") }, "任务路径参数");
const headers = obj({ "if-match": str("从任务 etag/ETag 获取的条件版本") }, "写入前提；版本冲突返回 409");
type Handler = (request: IncomingMessage, response: ServerResponse, caller?: AuthenticatedCaller, fastifyRequest?: FastifyRequest) => void | Promise<void>;
interface Router {
  register(method: string, path: string, handler: Handler, schema: Record<string, unknown>): void;
  read(request: IncomingMessage): Promise<Record<string, unknown>>;
  send(response: ServerResponse, status: number, value: unknown): void;
}
export function registerAutomationRoutes(router: Router, service: AutomationTaskService): void {
  const prefix = "/api/agent/automation-tasks";
  const query = (req: IncomingMessage) => new URL(req.url!, "http://localhost").searchParams;
  const id = (req?: FastifyRequest) => (req!.params as { task_id: string }).task_id;
  const send = (response: ServerResponse, task: ReturnType<AutomationTaskService["get"]> | null, status = 200) => { if (!task) throw new Error("Task response required"); response.setHeader("ETag", task.etag); router.send(response, status, { data: task }); };
  const schema = (operationId: string, summary: string, response: TSchema, extras: Record<string, unknown> = {}) => ({ operationId, summary, description: summary + "。仅当前 tenant/member 的本地数据；执行内容不上传。", tags: ["automation-tasks"], ...extras, response: { 200: json(response), 401: problem("Unauthorized"), 403: problem("Forbidden"), 404: problem("NotFound"), 409: problem("Conflict"), 422: problem("ValidationError"), 503: problem("ManagerUnavailable") } });
  router.register("GET", prefix, (req, res, caller) => router.send(res, 200, service.list(caller!, query(req))), schema("listAutomationTasks", "查询自动化任务（含旧会话调度）", list(ListTask), { querystring: obj({ category: Type.Optional(str("all/report/monitor/reminder/other")), status: Type.Optional(str("all/active/paused/completed")), q: Type.Optional(str("名称、指令摘要、员工搜索", { maxLength: 120 })), employee_id: Type.Optional(str("员工筛选")), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "分页大小，默认 50" })), cursor: Type.Optional(str("不透明分页游标")) }, "查询条件") }));
  const createSchema = schema("createAutomationTask", "创建任务并初始化本地执行会话", envelope(Task), { body: obj({ ...writable, connector_ids: Type.Optional(writable.connector_ids) }, "创建任务"), headers: obj({ "idempotency-key": str("创建幂等键，作用域为 tenant/member/创建操作") }, "创建请求头") });
  createSchema.response = { ...createSchema.response, 201: json(envelope(Task)) } as typeof createSchema.response;
  delete (createSchema.response as Record<string, unknown>)["200"];
  router.register("POST", prefix, async (req, res, caller) => send(res, await service.create(await router.read(req), caller!, req.headers["idempotency-key"] as string | undefined), 201), createSchema);
  router.register("GET", `${prefix}/:task_id`, (_req, res, caller, fastify) => send(res, service.get(id(fastify), caller!)), schema("getAutomationTask", "查询任务详情和条件版本", envelope(Task), { params }));
  router.register("PATCH", `${prefix}/:task_id`, async (req, res, caller, fastify) => send(res, await service.patch(id(fastify), await router.read(req), caller!, req.headers["if-match"] as string | undefined)), schema("updateAutomationTask", "编辑任务，员工切换保留旧会话历史", envelope(Task), { params, headers, body: Type.Partial(obj(writable, "部分更新字段")) }));
  for (const action of ["enable", "pause"] as const) router.register("POST", `${prefix}/:task_id/actions/${action}`, (req, res, caller, fastify) => send(res, service.action(id(fastify), action, caller!, req.headers["if-match"] as string | undefined)), schema(`${action}AutomationTask`, action === "enable" ? "启用后续调度" : "暂停后续调度，不取消当前执行", envelope(Task), { params, headers }));
  router.register("DELETE", `${prefix}/:task_id`, (req, res, caller, fastify) => { service.action(id(fastify), "delete", caller!, req.headers["if-match"] as string | undefined); res.writeHead(204); res.end(); }, { ...schema("deleteAutomationTask", "软删除任务并保留运行历史", envelope(Task), { params, headers }), response: { 204: { description: "删除成功，无响应体" }, 401: problem("Unauthorized"), 404: problem("NotFound"), 409: problem("Conflict"), 422: problem("ValidationError") } });
  router.register("GET", `${prefix}/:task_id/runs`, (req, res, caller, fastify) => router.send(res, 200, service.runs(id(fastify), caller!, query(req))), schema("listAutomationTaskRuns", "查询触发与工作记录关联，unknown 不可自动重放", list(Run), { params, querystring: obj({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "每页条数" })), cursor: Type.Optional(str("分页游标")), include_deleted: Type.Optional(str("true 时允许当前所有者查看软删除任务历史")) }, "运行查询") }));
  router.register("GET", "/api/agent/connectors", (req, res, caller) => { const q = query(req); const rows = service.connectors(caller!, q.get("employee_id") ?? undefined).filter(c => !q.get("status") || q.get("status") === c.status); router.send(res, 200, { data: rows, page: { next_cursor: null, has_more: false } }); }, schema("listAgentConnectors", "查询当前成员本地安装且员工获授权的连接器", list(Connector), { querystring: obj({ status: Type.Optional(str("enabled/unavailable")), employee_id: Type.Optional(str("按员工授权筛选")) }, "连接器查询") }));
}

const exampleInput = { name: "每日简报", prompt: "汇总项目进度", category: "report", employee_id: "employee-1", connector_ids: [], schedule: { mode: "daily", timezone: "Asia/Shanghai", time: "09:00:00" } };
const exampleTask = { ...exampleInput, task_id: "e5c06741-cdf0-4132-9b29-ab2969bc11b3", prompt_summary: "汇总项目进度", employee: { employee_id: "employee-1", display_name: "研究员" }, connectors: [], status: "active", block_reason: null, conversation_id: "13c7d450-703f-497e-85c2-4d8f6dc35d6b", target_kind: "private", origin: "automation", etag: '\"1-2\"', last_run_at: null, last_run: null, next_run_at: "2026-09-23T01:00:00.000Z", created_by: "member-1", created_at: "2026-09-22T00:00:00.000Z", updated_at: "2026-09-22T00:00:00.000Z" };
const example = (value: unknown) => ({ sample: { summary: "示例", value } });
const responseExample = (value: unknown) => ({ description: "当前成员的本地任务资源。", examples: example(value) });
const { prompt: _prompt, ...exampleListTask } = exampleTask;
export const AUTOMATION_PARAMETER_EXAMPLES = { task_id: exampleTask.task_id, category: "all", status: "all", q: "简报", "idempotency-key": "create-daily-report", "if-match": exampleTask.etag, include_deleted: "true" };
export const AUTOMATION_OPERATION_DOCS = {
  listAutomationTasks: { responses: { "200": responseExample({ data: [exampleListTask], page: { next_cursor: null, has_more: false } }) } },
  createAutomationTask: { request: example(exampleInput), responses: { "201": responseExample({ data: exampleTask }) } },
  getAutomationTask: { responses: { "200": responseExample({ data: exampleTask }) } },
  updateAutomationTask: { request: example({ name: "新的简报名称" }), responses: { "200": responseExample({ data: exampleTask }) } },
  enableAutomationTask: { responses: { "200": responseExample({ data: exampleTask }) } },
  pauseAutomationTask: { responses: { "200": responseExample({ data: { ...exampleTask, status: "paused", next_run_at: null } }) } },
  listAutomationTaskRuns: { responses: { "200": responseExample({ data: [], page: { next_cursor: null, has_more: false } }) } },
  listAgentConnectors: { responses: { "200": responseExample({ data: [], page: { next_cursor: null, has_more: false } }) } },
};
