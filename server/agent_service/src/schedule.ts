import { createHash } from "node:crypto";
import { encodeScope } from "./runtime-lease-cache.js";
import type { AuthenticatedCaller } from "./http/auth.js";
import { PreExecutionAuthorizationError, type SessionHost } from "./pi/session-host.js";
import { IdempotencyUnknownError, ScheduleRevisionConflictError, type AgentSqliteStore, type ConversationRecord } from "./storage/sqlite.js";
import type { ExecutionAuthorizationRegistry } from "./execution-authorization.js";

export interface ConversationSchedule {
  schedule_id: string;
  revision: number;
  enabled: boolean;
  at?: string;
  interval_seconds?: number;
  one_shot: boolean;
  overlap: "skip";
  misfire: "skip";
  prompt_template: string;
}

const ALLOWED = new Set(["schedule_id", "revision", "enabled", "at", "interval_seconds", "one_shot", "overlap", "misfire", "prompt_template"]);

export function validateSchedule(value: unknown): ConversationSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule must be an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!ALLOWED.has(key)) throw new Error(`schedule field is not supported: ${key}`);
  if (typeof raw.schedule_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.schedule_id)) throw new Error("schedule_id must be a safe non-empty string");
  const revision = raw.revision === undefined ? 1 : raw.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) throw new Error("revision must be a positive integer");
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
  const oneShot = raw.one_shot === true;
  if (raw.one_shot !== undefined && typeof raw.one_shot !== "boolean") throw new Error("one_shot must be boolean");
  const at = raw.at;
  if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) throw new Error("at must be an ISO timestamp");
  const interval = raw.interval_seconds;
  if (interval !== undefined && (!Number.isInteger(interval) || (interval as number) < 1)) throw new Error("interval_seconds must be a positive integer");
  if (oneShot && at === undefined) throw new Error("one_shot schedules require at");
  if (at === undefined && interval === undefined) throw new Error("schedule requires at or interval_seconds");
  if (at !== undefined && interval === undefined && !oneShot) throw new Error("repeating schedules require interval_seconds");
  if (at !== undefined && interval !== undefined && oneShot) throw new Error("one_shot cannot be combined with interval_seconds");
  if (raw.overlap !== undefined && raw.overlap !== "skip") throw new Error("overlap must be skip");
  if (raw.misfire !== undefined && raw.misfire !== "skip") throw new Error("misfire must be skip");
  if (typeof raw.prompt_template !== "string" || raw.prompt_template.trim().length === 0 || raw.prompt_template.length > 200_000) throw new Error("prompt_template must be a non-empty string <= 200000 characters");
  return {
    schedule_id: raw.schedule_id,
    revision: revision as number,
    enabled,
    ...(at === undefined ? {} : { at: new Date(at as string).toISOString() }),
    ...(interval === undefined ? {} : { interval_seconds: interval as number }),
    one_shot: oneShot,
    overlap: "skip",
    misfire: "skip",
    prompt_template: raw.prompt_template,
  };
}

export interface ScheduleServiceOptions {
  intervalMs?: number;
  now?: () => number;
  authorization?: ExecutionAuthorizationRegistry;
}

export class ScheduleService {
  private timer?: NodeJS.Timeout;
  private lastTick?: number;
  private readonly retryableOccurrences = new Map<string, { scheduleId: string; occurrence: number; revision: number; scheduleGeneration: number }>();

  constructor(private readonly store: AgentSqliteStore, private readonly host: SessionHost, private readonly options: ScheduleServiceOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.lastTick = this.now();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = this.now()): Promise<number> {
    const previous = this.lastTick ?? now;
    if (this.lastTick === undefined) this.lastTick = now;
    if (now <= previous) return 0;
    let launched = 0;
    let authorizationBlocked = false;
    for (const conversation of this.store.listScheduledConversations()) {
      const schedule = conversation.schedule;
      if (!schedule) continue;
      let parsed: ConversationSchedule;
      try { parsed = validateSchedule(schedule); } catch { continue; }
      if (!conversation.tenantId || !conversation.memberId) continue;
      const scheduleGeneration = conversation.scheduleGeneration ?? 0;
      const retry = this.retryableOccurrences.get(conversation.id);
      if (retry && (retry.revision !== parsed.revision || retry.scheduleId !== parsed.schedule_id || retry.scheduleGeneration !== scheduleGeneration)) this.retryableOccurrences.delete(conversation.id);
      const persistedRetryMatches = conversation.scheduleRetryScheduleId === parsed.schedule_id
        && conversation.scheduleRetryRevision === parsed.revision
        && conversation.scheduleRetryGeneration === scheduleGeneration
        && conversation.scheduleRetryAt;
      if (conversation.scheduleRetryAt && !persistedRetryMatches) this.store.clearScheduleRetry(conversation.id);
      if (!parsed.enabled) {
        this.retryableOccurrences.delete(conversation.id);
        if (conversation.scheduleRetryAt) this.store.clearScheduleRetry(conversation.id);
        continue;
      }
      const persistedRetry = persistedRetryMatches ? Date.parse(conversation.scheduleRetryAt!) : undefined;
      const retrying = (retry !== undefined && retry.revision === parsed.revision && retry.scheduleId === parsed.schedule_id && retry.scheduleGeneration === scheduleGeneration) || Number.isFinite(persistedRetry);
      const occurrence = retrying
        ? (retry?.revision === parsed.revision && retry.scheduleId === parsed.schedule_id && retry.scheduleGeneration === scheduleGeneration ? retry.occurrence : persistedRetry!)
        : this.occurrenceBetween(parsed, previous, now);
      if (occurrence === undefined || this.host.isPrompting(conversation.id)) continue;
      if (this.options.authorization && !this.options.authorization.resolve(conversation.tenantId, conversation.memberId, { requireAccessToken: true })) {
        // Keep the watermark behind the occurrence. A later authenticated
        // request can retry this exact one-shot without consuming it early.
        authorizationBlocked = true;
        continue;
      }
      if (await this.launch(conversation, parsed, occurrence)) {
        launched += 1;
        if (retrying) this.retryableOccurrences.delete(conversation.id);
      }
      if (this.options.authorization && !this.options.authorization.resolve(conversation.tenantId, conversation.memberId, { requireAccessToken: true })) authorizationBlocked = true;
    }
    if (!authorizationBlocked) this.lastTick = now;
    return launched;
  }

  private async launch(conversation: ConversationRecord, schedule: ConversationSchedule, occurrence: number): Promise<boolean> {
    const occurrenceUtc = new Date(occurrence).toISOString();
    const key = createHash("sha256").update(encodeScope([schedule.schedule_id, occurrenceUtc, conversation.id])).digest("hex");
    const scheduledCaller = this.options.authorization?.resolve(conversation.tenantId!, conversation.memberId!, { requireAccessToken: true });
    // Resolve user identity before reservePrompt: a missing/expired token must
    // not consume a one-shot occurrence or close its schedule.
    if (this.options.authorization && !scheduledCaller) return false;
    const caller: AuthenticatedCaller = scheduledCaller ?? { callerId: `schedule:${conversation.tenantId}:${conversation.memberId}`, userId: conversation.memberId!, tenantId: conversation.tenantId! };
    const fingerprint = createHash("sha256").update(JSON.stringify({ text: schedule.prompt_template, schedule_id: schedule.schedule_id, occurrence: occurrenceUtc })).digest("hex");
    let receipt;
    try {
      receipt = this.store.reservePrompt({ conversationId: conversation.id, callerId: caller.callerId, key, fingerprint, oneShot: schedule.one_shot, scheduleId: schedule.schedule_id, scheduleRevision: schedule.revision, scheduleGeneration: conversation.scheduleGeneration, clearScheduleRetry: true });
    } catch (error) {
      if (error instanceof IdempotencyUnknownError || error instanceof ScheduleRevisionConflictError) {
        this.retryableOccurrences.delete(conversation.id);
        return false;
      }
      throw error;
    }
    if (!receipt.isNew) {
      this.retryableOccurrences.delete(conversation.id);
      return false;
    }
    void this.host.prompt(conversation.id, schedule.prompt_template, undefined, caller).then(
      (lastEntryId) => lastEntryId
        ? this.store.markCompleted(conversation.id, caller.callerId, key, lastEntryId, receipt.ownerInstance)
        : this.store.markUnknown(conversation.id, caller.callerId, key, receipt.ownerInstance, undefined, { code: "prompt_not_settled", detail: "Prompt did not produce a proven terminal entry" }),
      (error) => {
        if (isPreExecutionAuthorizationFailure(error) && receipt.scheduleGeneration !== undefined && this.store.releasePreExecutionPrompt(conversation.id, caller.callerId, key, receipt.ownerInstance, schedule.one_shot, { scheduleId: schedule.schedule_id, occurrenceAt: occurrenceUtc, revision: schedule.revision, scheduleGeneration: receipt.scheduleGeneration, blockReason: "authorization_required" })) {
          const currentRecord = this.store.getConversation(conversation.id);
          if (currentRecord?.schedule?.schedule_id === schedule.schedule_id && currentRecord.schedule?.revision === schedule.revision && currentRecord.scheduleGeneration !== undefined) {
            this.retryableOccurrences.set(conversation.id, { scheduleId: schedule.schedule_id, occurrence, revision: schedule.revision, scheduleGeneration: currentRecord.scheduleGeneration });
          }
          return;
        }
        this.store.markUnknown(conversation.id, caller.callerId, key, receipt.ownerInstance, undefined, { code: "execution_failed", detail: safeScheduleFailure(error) });
      },
    );
    return true;
  }

  private occurrenceBetween(schedule: ConversationSchedule, previous: number, now: number): number | undefined {
    const anchor = schedule.at ? Date.parse(schedule.at) : 0;
    if (schedule.one_shot) return anchor > previous && anchor <= now ? anchor : undefined;
    const interval = (schedule.interval_seconds ?? 0) * 1000;
    if (!interval) return undefined;
    const index = Math.floor((now - anchor) / interval);
    if (index < 0) return undefined;
    const occurrence = anchor + index * interval;
    return occurrence > previous && occurrence <= now ? occurrence : undefined;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

function safeScheduleFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Scheduled prompt failed";
  return raw
    .replace(/(?:bearer\s+|(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu, "[内容已隐藏]")
    .replace(/(?:\/(?:Users|Volumes|private|home|tmp|var|workspace|etc|root|opt|srv|mnt|data)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/giu, "[路径已隐藏]")
    .slice(0, 300);
}

function isPreExecutionAuthorizationFailure(error: unknown): boolean {
  // Only the host's explicit pre-execution marker is retryable. A raw
  // downstream 401/403 from an existing Session may represent an unknown
  // side-effect result and must never replay a one-shot.
  return error instanceof PreExecutionAuthorizationError;
}
