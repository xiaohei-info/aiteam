import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface RequestContext { request_id: string; trace_id: string; traceparent: string }
export const requestContext = new AsyncLocalStorage<RequestContext>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function safeRequestId(value: unknown): string {
  return typeof value === "string" && (uuid.test(value) || /^req_[0-9a-f]{32}$/.test(value)) ? value : randomUUID();
}
export function makeRequestContext(id: unknown, parent: unknown): RequestContext {
  const parsed = typeof parent === "string" ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(parent) : null;
  const valid = parsed && parsed[1] !== "0".repeat(32) && parsed[2] !== "0".repeat(16);
  const trace_id = valid ? parsed[1]! : randomUUID().replaceAll("-", "");
  return { request_id: safeRequestId(id), trace_id, traceparent: `00-${trace_id}-${randomUUID().replaceAll("-", "").slice(0, 16)}-${valid ? parsed[3] : "01"}` };
}
const identifiers = new Set(["conversation_id", "employee_id", "work_id", "tenant_id", "source_id"]);
const numbers = new Set(["status", "duration_ms", "count", "port", "exit_code"]);
const labels = new Set(["method", "outcome", "source_type", "error_type", "dependency", "phase"]);
const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numbers.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = Math.max(0, Math.round(value * 1000) / 1000);
    else if (identifiers.has(key) && typeof value === "string" && uuid.test(value)) result[key] = value;
    else if (labels.has(key) && typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) result[key] = value;
    // Only call sites owning route templates can supply this field. Never raw URLs.
    else if (key === "route" && typeof value === "string" && /^\/[A-Za-z0-9_/:{}.*-]{0,180}$/.test(value)) result[key] = value;
  }
  return result;
}
export function safeError(error: unknown): Record<string, unknown> {
  // Do not trust error.name/code/message from providers or user tools.
  return { error_type: error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof Error ? "Error" : "UnknownError" };
}

/** Per-instance files avoid concurrent writers; bounded total retention across restarts. */
export class RotatingLog {
  readonly path: string;
  failures = 0;
  constructor(private directory: string, private maxBytes = 2 * 1024 * 1024, private backups = 3) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Log directory must not be a symlink");
    chmodSync(directory, 0o700);
    this.path = join(directory, `agent-${Date.now()}-${process.pid}-${randomUUID()}.jsonl`);
    this.prune();
  }
  private prune(): void {
    const files = readdirSync(this.directory).filter(name => /^agent-[0-9]+-[0-9]+-[0-9a-f-]+\.jsonl(?:\.[1-3])?$/.test(name))
      .map(name => ({ path: join(this.directory, name), stat: lstatSync(join(this.directory, name)) }))
      .filter(file => file.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let bytes = 0;
    for (const file of files) {
      bytes += file.stat.size;
      if (bytes > 32 * 1024 * 1024 || file.stat.mtimeMs < Date.now() - 7 * 86400_000) rmSync(file.path);
    }
  }
  write(line: string): void {
    try {
      if (Buffer.byteLength(line) > 8192) { this.failures++; return; }
      let size = 0;
      try { if (lstatSync(this.path).isSymbolicLink()) throw new Error("Unsafe log file"); size = statSync(this.path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        for (let index = this.backups; index >= 1; index--) {
          const from = index === 1 ? this.path : `${this.path}.${index - 1}`;
          const to = `${this.path}.${index}`;
          rmSync(to, { force: true });
          try { renameSync(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        this.prune();
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch { this.failures++; }
  }
}

export class ApplicationLogger {
  readonly instance_id = randomUUID();
  constructor(private sink: (line: string) => void = () => {}, private level: LogLevel = "info") {}
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (levels[level] < levels[this.level]) return;
    const context = requestContext.getStore();
    const record = { schema_version: 1, timestamp: new Date().toISOString(), service: "agent", instance_id: this.instance_id, pid: process.pid, level,
      event: /^[a-z][a-z0-9_.]{0,79}$/.test(event) ? event : "invalid_event", ...context, ...safeFields(fields) };
    try { this.sink(`${JSON.stringify(record)}\n`); } catch { /* Diagnostics must never break execution. */ }
  }
}
export let appLogger = new ApplicationLogger();
export function configureAgentLogging(directory: string, level = "info"): void {
  const selected: LogLevel = Object.hasOwn(levels, level.toLowerCase()) ? level.toLowerCase() as LogLevel : "info";
  try {
    const file = new RotatingLog(directory);
    appLogger = new ApplicationLogger(line => { file.write(line); process.stdout.write(line); }, selected);
  } catch {
    appLogger = new ApplicationLogger(line => process.stdout.write(line), selected);
    appLogger.log("error", "logging.file_unavailable");
  }
  process.on("uncaughtExceptionMonitor", error => appLogger.log("error", "process.uncaught_exception", safeError(error)));
}

/** Propagate only safe correlation metadata; never capture URL, body or credentials. */
export function observedFetch(fetchImpl: typeof fetch, dependency = "manager"): typeof fetch {
  return async (input, init) => {
    const context = requestContext.getStore() ?? makeRequestContext(undefined, undefined);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("X-Request-ID", context.request_id);
    headers.set("traceparent", context.traceparent);
    const started = performance.now();
    return requestContext.run(context, async () => {
      try {
        const response = await fetchImpl(input, { ...init, headers });
        appLogger.log(response.ok ? "info" : "warn", "dependency.completed", { dependency, status: response.status, duration_ms: performance.now() - started });
        return response;
      } catch (error) {
        appLogger.log("error", "dependency.failed", { dependency, duration_ms: performance.now() - started, ...safeError(error) });
        throw error;
      }
    });
  };
}
