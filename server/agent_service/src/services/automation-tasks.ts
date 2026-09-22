import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { AuthenticatedCaller } from "../http/auth.js";
import type { SessionHost } from "../pi/session-host.js";
import type { AgentSqliteStore, ConversationRecord } from "../storage/sqlite.js";
import { AutomationError, type AutomationTaskRow, type TaskOwner } from "../storage/automation-tasks.js";
import { validateSchedule, nextScheduleAt, type ConversationSchedule } from "../schedule.js";
import { validateCalendar } from "../schedule-calendar.js";
import { authorizedConnectors, validateConnectorSelection } from "../connectors.js";
import { compareReadOrder, decodeReadCursor, encodeReadCursor, readCursorScope } from "../storage/read-cursor.js";
import { WorkRecordReadService } from "./work-records.js";
import type { ExecutionAuthorizationRegistry } from "../execution-authorization.js";

export const ownerOf = (caller: AuthenticatedCaller): TaskOwner => ({ tenantId: caller.tenantId!, memberId: caller.userId ?? caller.callerId });
const categories = ["report", "monitor", "reminder", "other"];
const fail = (code: string, detail: string): never => { throw new AutomationError(422, code, detail); };
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) return fail(`${name}_invalid`, `${name} must contain 1–${max} characters`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("validation_error", "Expected an object");
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail("validation_error", "Unsupported field");
}
function timestamp(value: unknown): string {
  try { return Temporal.Instant.from(String(value)).toString({ smallestUnit: "millisecond" }); }
  catch { return fail("task_schedule_invalid", "An ISO timestamp with offset is required"); }
}
export function taskSchedule(value: unknown, prompt: string, id: string, revision = 1, enabled = true): ConversationSchedule {
  const rule = object(value);
  const base = { schedule_id: id, revision, enabled, prompt_template: prompt };
  try {
    if (typeof rule.timezone !== "string" || /^[+-]/.test(rule.timezone)) throw new Error("IANA timezone required");
    new Intl.DateTimeFormat("en", { timeZone: rule.timezone });
    if (["daily", "weekly", "monthly"].includes(String(rule.mode))) return validateSchedule({ ...base, calendar: validateCalendar(rule) });
    if (rule.mode === "once") {
      onlyKeys(rule, ["mode", "timezone", "run_at"]);
      return validateSchedule({ ...base, one_shot: true, at: timestamp(rule.run_at) });
    }
    if (rule.mode === "interval") {
      onlyKeys(rule, ["mode", "timezone", "interval_seconds", "starts_at"]);
      if (!Number.isSafeInteger(rule.interval_seconds) || Number(rule.interval_seconds) < 300 || Number(rule.interval_seconds) > 315_360_000) throw new Error("interval_seconds must be 300–315360000");
      return validateSchedule({ ...base, at: timestamp(rule.starts_at), interval_seconds: rule.interval_seconds });
    }
    throw new Error("Unsupported schedule mode");
  } catch (error) { return fail("task_schedule_invalid", error instanceof Error ? error.message : "Invalid schedule"); }
}
function publicSchedule(schedule: ConversationSchedule | null) {
  if (!schedule) return null;
  if (schedule.calendar) return schedule.calendar;
  return schedule.one_shot ? { mode: "once", timezone: "UTC", run_at: schedule.at } : { mode: "interval", timezone: "UTC", interval_seconds: schedule.interval_seconds, starts_at: schedule.at ?? "1970-01-01T00:00:00.000Z" };
}

export class AutomationTaskService {
  private readonly creating = new Set<string>();
  constructor(private readonly store: AgentSqliteStore, private readonly host: SessionHost, private readonly authorization?: ExecutionAuthorizationRegistry) {}

  connectors(caller: AuthenticatedCaller, employeeId?: string) { return authorizedConnectors(this.store, ownerOf(caller), employeeId); }

  private resolve(id: string, caller: AuthenticatedCaller, includeDeleted = false): { task?: AutomationTaskRow; conversation?: ConversationRecord; id: string } {
    const owner = ownerOf(caller);
    const task = this.store.automation.get(id, owner);
    if (task) {
      if (task.deleted_at && !includeDeleted) throw new AutomationError(404, "task_not_found", "Task not found");
      return { task, conversation: this.store.getOwnedConversation(task.conversation_id, owner.tenantId, owner.memberId), id };
    }
    const conversation = this.store.getOwnedConversation(id, owner.tenantId, owner.memberId);
    if (!conversation?.schedule || this.store.automation.forConversation(id)) throw new AutomationError(404, "task_not_found", "Task not found");
    return { conversation, id };
  }

  get(id: string, caller: AuthenticatedCaller, includeDeleted = false) {
    const { task, conversation } = this.resolve(id, caller, includeDeleted);
    const owner = ownerOf(caller);
    const employeeId = conversation?.entryEmployeeId ?? conversation?.coordinatorEmployeeId ?? null;
    const employee = this.store.listLoadedExperts(owner.tenantId, owner.memberId).find(e => e.employee_id === employeeId);
    const schedule = conversation?.schedule ? validateSchedule(conversation.schedule) : null;
    const last = this.runRows(id, caller, 1).at(0) ?? null;
    const consumed = Boolean(schedule?.one_shot && last?.receipt_key && last.schedule_id === schedule.schedule_id && last.scheduled_at === schedule.at && !conversation?.scheduleRetryAt);
    const finished = consumed && last && !["running", "queued", "blocked"].includes(last.status);
    const status = finished ? "completed" : schedule?.enabled || (consumed && last?.status === "running") ? "active" : "paused";
    const connectorIds: string[] = task ? JSON.parse(task.connector_ids) : [];
    let available: ReturnType<AutomationTaskService["connectors"]> = [];
    if (connectorIds.length) { try { available = this.connectors(caller, employeeId ?? undefined); } catch (error) { if (!(error instanceof AutomationError)) throw error; } }
    const blockReason = !schedule ? "configuration_required" : conversation?.scheduleBlockReason ?? (connectorIds.some(id => !available.some(c => c.connector_id === id && c.status === "enabled")) ? "connector_unavailable" : null) ?? (this.authorization && !this.authorization.resolve(owner.tenantId, owner.memberId, { requireAccessToken: true }) ? "authorization_required" : null);
    return {
      task_id: id, name: task?.name ?? conversation?.title ?? "定时任务", category: task?.category ?? "other",
      prompt: schedule?.prompt_template ?? "", prompt_summary: (schedule?.prompt_template ?? "").slice(0, 240),
      employee_id: employeeId, employee: employee ? { employee_id: employee.employee_id, display_name: employee.display_name } : null,
      connector_ids: connectorIds, connectors: available.filter(c => connectorIds.includes(c.connector_id)), schedule: publicSchedule(schedule),
      status, block_reason: blockReason, conversation_id: conversation?.id ?? null, target_kind: conversation?.kind === "group" ? "group" : "private",
      origin: task ? "automation" : "conversation", etag: `"${task?.revision ?? 0}-${conversation?.scheduleGeneration ?? 0}"`,
      last_run_at: last?.started_at ?? null, last_run: last, next_run_at: schedule && !task?.deleted_at ? nextScheduleAt(schedule) : null,
      created_by: owner.memberId, created_at: task?.created_at ?? conversation?.createdAt ?? "", updated_at: [task?.updated_at ?? "", conversation?.updatedAt ?? ""].sort().at(-1)!,
    };
  }

  list(caller: AuthenticatedCaller, query: URLSearchParams) {
    onlyKeys(Object.fromEntries(query), ["category", "status", "q", "employee_id", "limit", "cursor"]);
    const owner = ownerOf(caller), category = query.get("category") ?? "all", status = query.get("status") ?? "all", q = query.get("q") ?? "", employeeId = query.get("employee_id");
    if (!["all", ...categories].includes(category) || !["all", "active", "paused", "completed"].includes(status) || q.length > 120) fail("invalid_filter", "Invalid task filter");
    const ids = this.store.automation.list(owner).filter(t => !t.deleted_at).map(t => t.id);
    for (const c of this.store.listScheduledConversations()) if (c.tenantId === owner.tenantId && c.memberId === owner.memberId && !this.store.automation.forConversation(c.id)) ids.push(c.id);
    const rows = ids.map(id => this.get(id, caller)).filter(t => (category === "all" || t.category === category) && (status === "all" || t.status === status) && (!q || `${t.name} ${t.prompt_summary} ${t.employee?.display_name ?? ""}`.toLowerCase().includes(q.toLowerCase())) && (!employeeId || t.employee_id === employeeId || (t.target_kind === "group" && this.store.listConversationParticipants(t.conversation_id!).some(p => p.employee_id === employeeId))))
      .map(({ prompt: _prompt, ...item }) => item);
    return this.page(rows, caller, query, "tasks", t => [t.created_at, t.task_id]);
  }

  async create(body: Record<string, unknown>, caller: AuthenticatedCaller, key: string | undefined) {
    onlyKeys(body, ["name", "prompt", "category", "employee_id", "connector_ids", "schedule"]);
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) fail("idempotency_key_required", "Idempotency-Key is required (1–128 printable characters)");
    const owner = ownerOf(caller), name = text(body.name, "task_name", 120), prompt = text(body.prompt, "prompt", 20_000);
    const category = this.category(body.category), employeeId = text(body.employee_id, "employee_id", 256), connectorIds = this.connectorIds(body.connector_ids ?? []);
    this.employee(employeeId, caller);
    validateConnectorSelection(this.store, owner, employeeId, connectorIds);
    const fingerprint = createHash("sha256").update(JSON.stringify({ name, prompt, category, employeeId, connectorIds, schedule: taskSchedule(body.schedule, prompt, "fingerprint") })).digest("hex");
    const db = this.store.db;
    const existing = db.prepare("SELECT * FROM automation_creation WHERE tenant_id = ? AND member_id = ? AND key = ?").get(owner.tenantId, owner.memberId, key!) as { task_id: string; conversation_id: string; fingerprint: string; completed: number; response_json: string | null } | undefined;
    if (existing && existing.fingerprint !== fingerprint) throw new AutomationError(409, "idempotency_key_reused", "Idempotency key was used with a different request");
    if (existing?.completed && existing.response_json) return JSON.parse(existing.response_json) as ReturnType<AutomationTaskService["get"]>;
    const id = existing?.task_id ?? randomUUID(), conversationId = existing?.conversation_id ?? randomUUID();
    if (this.creating.has(id)) throw new AutomationError(409, "task_creation_pending", "Task creation is in progress; retry with the same key");
    this.creating.add(id);
    try {
      if (!existing) this.store.automation.transaction(() => {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO automation_creation(tenant_id, member_id, key, fingerprint, task_id, conversation_id) VALUES (?, ?, ?, ?, ?, ?)").run(owner.tenantId, owner.memberId, key!, fingerprint, id, conversationId);
        this.store.createConversation({ id: conversationId, tenantId: owner.tenantId, memberId: owner.memberId, title: name, kind: "private", entryEmployeeId: employeeId, permissionMode: "read-only", schedule: null });
        this.store.automation.insert({ id, tenant_id: owner.tenantId, member_id: owner.memberId, name, category, conversation_id: conversationId, connector_ids: JSON.stringify(connectorIds), revision: 1, created_at: now, updated_at: now, deleted_at: null });
      });
      await this.host.initializeConversationParticipants(conversationId, caller);
      return this.store.automation.transaction(() => {
        const task = this.store.automation.get(id, owner);
        if (!task || task.deleted_at) throw new AutomationError(409, "task_creation_cancelled", "Task creation was cancelled");
        db.prepare("UPDATE automation_creation SET completed = 1 WHERE tenant_id = ? AND member_id = ? AND key = ?").run(owner.tenantId, owner.memberId, key!);
        const schedule = taskSchedule(body.schedule, prompt, id);
        this.store.updateConversation(conversationId, { schedule: { ...schedule } });
        const result = this.get(id, caller);
        db.prepare("UPDATE automation_creation SET completed = 1, response_json = ? WHERE tenant_id = ? AND member_id = ? AND key = ?").run(JSON.stringify(result), owner.tenantId, owner.memberId, key!);
        return result;
      });
    } finally { this.creating.delete(id); }
  }

  async patch(id: string, body: Record<string, unknown>, caller: AuthenticatedCaller, etag: string | undefined) {
    onlyKeys(body, ["name", "prompt", "category", "employee_id", "connector_ids", "schedule"]);
    this.checkVersion(id, caller, etag);
    this.requireInitialized(id);
    const { conversation, task } = this.resolve(id, caller);
    if (!conversation) throw new AutomationError(409, "conversation_deleted", "Execution conversation was deleted");
    if (["employee_id", "connector_ids", "prompt", "schedule"].some(k => k in body) && this.host.isPrompting(conversation.id)) throw new AutomationError(409, "task_busy", "Pause or wait for the current execution before changing execution settings");
    const current = this.get(id, caller), owner = ownerOf(caller);
    const name = body.name === undefined ? current.name : text(body.name, "task_name", 120);
    const category = body.category === undefined ? current.category : this.category(body.category);
    const ids = body.connector_ids === undefined ? current.connector_ids : this.connectorIds(body.connector_ids);
    const employeeId = body.employee_id === undefined ? current.employee_id : text(body.employee_id, "employee_id", 256);
    if (current.target_kind === "group" && (body.employee_id !== undefined || body.connector_ids !== undefined)) fail("group_target_immutable", "Edit group membership using the existing group interface");
    if (employeeId && (body.employee_id !== undefined || body.connector_ids !== undefined)) { this.employee(employeeId, caller); validateConnectorSelection(this.store, owner, employeeId, ids); }
    let schedule = conversation.schedule ? validateSchedule(conversation.schedule) : null;
    if (body.schedule !== undefined) schedule = taskSchedule(body.schedule, body.prompt === undefined ? current.prompt : text(body.prompt, "prompt", 20_000), schedule?.schedule_id ?? id, (schedule?.revision ?? 0) + 1, schedule?.enabled ?? true);
    else if (body.prompt !== undefined) {
      if (!schedule) fail("configuration_required", "Configure a schedule before editing the prompt");
      schedule = { ...schedule!, prompt_template: text(body.prompt, "prompt", 20_000), revision: schedule!.revision + 1 };
    }
    let nextId = conversation.id;
    const switching = employeeId !== current.employee_id;
    if (switching) {
      nextId = randomUUID();
      this.store.createConversation({ id: nextId, tenantId: owner.tenantId, memberId: owner.memberId, title: name, kind: "private", entryEmployeeId: employeeId, permissionMode: conversation.permissionMode, schedule: null });
      try { await this.host.initializeConversationParticipants(nextId, caller); }
      catch (error) { await this.host.delete(nextId, owner.tenantId, owner.memberId); throw error; }
    }
    try {
      this.store.automation.transaction(() => {
        this.checkVersion(id, caller, etag);
        if (switching && this.host.isPrompting(conversation.id)) throw new AutomationError(409, "task_busy", "Task started during the edit");
        const row = task ?? this.materialize(id, caller);
        if (switching) { this.store.updateConversation(conversation.id, { schedule: null }); this.store.automation.bind(id, nextId); }
        this.store.automation.update({ ...row, name, category, conversation_id: nextId, connector_ids: JSON.stringify(ids) });
        if (switching || body.schedule !== undefined || body.prompt !== undefined) this.store.updateConversation(nextId, { schedule: schedule ? { ...schedule } : null });
      });
    } catch (error) { if (switching) await this.host.delete(nextId, owner.tenantId, owner.memberId); throw error; }
    return this.get(id, caller);
  }

  action(id: string, action: "enable" | "pause" | "delete", caller: AuthenticatedCaller, etag: string | undefined) {
    return this.store.automation.transaction(() => {
      this.checkVersion(id, caller, etag);
      if (action !== "delete") this.requireInitialized(id);
      const { conversation } = this.resolve(id, caller);
      const row = this.store.automation.get(id, ownerOf(caller)) ?? this.materialize(id, caller);
      const schedule = conversation?.schedule ? validateSchedule(conversation.schedule) : null;
      if (action === "enable" && (!schedule || this.get(id, caller).status === "completed")) throw new AutomationError(409, "task_not_enableable", "Configure a future occurrence before enabling this task");
      const enabled = action === "enable";
      if (schedule && schedule.enabled !== enabled) this.store.updateConversation(conversation!.id, { schedule: { ...schedule, enabled } });
      if (action === "delete") this.store.automation.update({ ...row, deleted_at: new Date().toISOString() });
      return action === "delete" ? null : this.get(id, caller);
    });
  }

  private materialize(id: string, caller: AuthenticatedCaller): AutomationTaskRow {
    const { conversation } = this.resolve(id, caller);
    const owner = ownerOf(caller), now = new Date().toISOString();
    const row: AutomationTaskRow = { id, tenant_id: owner.tenantId, member_id: owner.memberId, name: conversation!.title ?? "定时任务", category: "other", conversation_id: conversation!.id, connector_ids: "[]", revision: 1, created_at: conversation!.createdAt ?? now, updated_at: now, deleted_at: null };
    this.store.automation.insert(row);
    return row;
  }
  private checkVersion(id: string, caller: AuthenticatedCaller, etag?: string): void {
    if (!etag) fail("if_match_required", "If-Match is required; reload the task before editing");
    if (this.get(id, caller).etag !== etag) throw new AutomationError(409, "task_revision_conflict", "Task changed; reload before saving");
  }
  private requireInitialized(id: string): void {
    if (this.store.db.prepare("SELECT 1 FROM automation_creation WHERE task_id = ? AND completed = 0").get(id)) throw new AutomationError(409, "task_creation_pending", "Task initialization has not completed; retry creation with the same key");
  }
  private category(value: unknown): string { return categories.includes(String(value)) ? String(value) : fail("category_invalid", "Unsupported category"); }
  private connectorIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 10 || value.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) || new Set(value).size !== value.length) return fail("connector_unavailable", "Expected at most 10 distinct connector references");
    return [...value].sort();
  }
  private employee(id: string, caller: AuthenticatedCaller): void {
    const owner = ownerOf(caller), employee = this.store.listLoadedExperts(owner.tenantId, owner.memberId).find(e => e.employee_id === id && !e.revoked);
    if (!employee || (employee.status && employee.status !== "active") || !this.store.listSnapshots(owner.tenantId, owner.memberId).some(s => s.employee_id === id && s.version === employee.version)) throw new AutomationError(403, "employee_not_authorized", "Employee is not authorized locally");
  }

  runs(id: string, caller: AuthenticatedCaller, query: URLSearchParams) {
    onlyKeys(Object.fromEntries(query), ["limit", "cursor", "include_deleted"]);
    this.resolve(id, caller, query.get("include_deleted") === "true");
    return this.page(this.runRows(id, caller), caller, query, `runs:${id}`, r => [r.scheduled_at, r.run_id]);
  }
  private runRows(id: string, caller: AuthenticatedCaller, limit = -1) {
    const owner = ownerOf(caller);
    const rows = this.store.db.prepare(`SELECT o.*, r.state AS receipt_state, r.failure_code FROM schedule_occurrence o
      LEFT JOIN idempotency_receipt r ON r.conversation_id = o.conversation_id AND r.caller_id = o.caller_id AND r.idempotency_key = o.receipt_key
      WHERE o.tenant_id = ? AND o.member_id = ? AND (o.conversation_id IN (SELECT conversation_id FROM automation_binding WHERE task_id = ?) OR o.conversation_id = ?)
      ORDER BY o.scheduled_at DESC, o.id DESC LIMIT ?`).all(owner.tenantId, owner.memberId, id, id, limit) as unknown as Array<{ id: string; conversation_id: string; scheduled_at: string; schedule_id: string; receipt_key: string | null; receipt_state: string | null; reason: string | null; failure_code: string | null }>;
    return rows.map(row => {
      const work = this.store.db.prepare("SELECT * FROM work_record WHERE conversation_id = ? AND tenant_id = ? AND member_id = ? AND prompt_receipt = ?").all(row.conversation_id, owner.tenantId, owner.memberId, row.receipt_key) as unknown as Array<{ id: string; outcome: string; started_at: number | null; ended_at: number | null }>;
      const results = work.map(w => w.outcome);
      const status = results.includes("active") ? "running" : results.includes("unknown") ? "unknown" : results.includes("error") ? "error" : results.includes("aborted") ? "aborted" : results.length && results.every(r => r === "succeeded") ? "succeeded" : row.reason === "overlap_skip" ? "skipped" : row.reason ? "blocked" : row.receipt_state === "accepted" ? "running" : "unknown";
      return { run_id: row.id, conversation_id: row.conversation_id, schedule_id: row.schedule_id, scheduled_at: row.scheduled_at, receipt_key: row.receipt_key,
        status: row.reason === "conversation_deleted" ? "unknown" : status,
        started_at: work.some(w => w.started_at !== null) ? new Date(Math.min(...work.flatMap(w => w.started_at === null ? [] : [w.started_at]))).toISOString() : null,
        finished_at: work.length && work.every(w => w.ended_at !== null) ? new Date(Math.max(...work.map(w => w.ended_at!))).toISOString() : null,
        error_code: row.reason ?? row.failure_code, result_summary: work.length ? new WorkRecordReadService(this.store, this.host).resultSummary(work.at(-1)!.id, caller) : null, work_record_ids: work.map(w => w.id) };
    });
  }
  private page<T>(rows: T[], caller: AuthenticatedCaller, query: URLSearchParams, resource: string, order: (row: T) => [string, string]) {
    const limit = Number(query.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit", "limit must be 1–100");
    const owner = ownerOf(caller), filters = [...query].filter(([k]) => k !== "cursor" && k !== "limit").sort();
    const scope = readCursorScope(resource, [owner.tenantId, owner.memberId], filters), cursor = query.get("cursor");
    const boundary = cursor ? decodeReadCursor(cursor, scope, ["string", "string"]) : undefined;
    const sorted = rows.sort((a, b) => -compareReadOrder(order(a), order(b))).filter(r => !boundary || compareReadOrder(order(r), boundary) < 0);
    const data = sorted.slice(0, limit);
    return { data, page: { has_more: sorted.length > limit, next_cursor: sorted.length > limit ? encodeReadCursor(scope, order(data.at(-1)!)) : null } };
  }
}
