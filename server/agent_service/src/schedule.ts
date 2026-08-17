import { createHash } from "node:crypto";
import type { AuthenticatedCaller } from "./http/auth.js";
import type { SessionHost } from "./pi/session-host.js";
import { IdempotencyUnknownError, type AgentSqliteStore, type ConversationRecord } from "./storage/sqlite.js";

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
}

export class ScheduleService {
  private timer?: NodeJS.Timeout;
  private lastTick?: number;

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
    this.lastTick = now;
    if (now <= previous) return 0;
    let launched = 0;
    for (const conversation of this.store.listScheduledConversations()) {
      const schedule = conversation.schedule;
      if (!schedule) continue;
      let parsed: ConversationSchedule;
      try { parsed = validateSchedule(schedule); } catch { continue; }
      if (!parsed.enabled || !conversation.tenantId || !conversation.memberId) continue;
      const occurrence = this.occurrenceBetween(parsed, previous, now);
      if (occurrence === undefined || this.host.isPrompting(conversation.id)) continue;
      if (await this.launch(conversation, parsed, occurrence)) launched += 1;
    }
    return launched;
  }

  private async launch(conversation: ConversationRecord, schedule: ConversationSchedule, occurrence: number): Promise<boolean> {
    const occurrenceUtc = new Date(occurrence).toISOString();
    const key = createHash("sha256").update(`${schedule.schedule_id}:${occurrenceUtc}:${conversation.id}`).digest("hex");
    const caller: AuthenticatedCaller = { callerId: `schedule:${conversation.tenantId}:${conversation.memberId}`, userId: conversation.memberId!, tenantId: conversation.tenantId! };
    const fingerprint = createHash("sha256").update(JSON.stringify({ text: schedule.prompt_template, schedule_id: schedule.schedule_id, occurrence: occurrenceUtc })).digest("hex");
    let receipt;
    try {
      receipt = this.store.reservePrompt({ conversationId: conversation.id, callerId: caller.callerId, key, fingerprint, oneShot: schedule.one_shot });
    } catch (error) {
      if (error instanceof IdempotencyUnknownError) return false;
      throw error;
    }
    if (!receipt.isNew) return false;
    void this.host.prompt(conversation.id, schedule.prompt_template, undefined, caller).then(
      (lastEntryId) => this.store.markCompleted(conversation.id, caller.callerId, key, lastEntryId, receipt.ownerInstance),
      () => this.store.markUnknown(conversation.id, caller.callerId, key, receipt.ownerInstance),
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
