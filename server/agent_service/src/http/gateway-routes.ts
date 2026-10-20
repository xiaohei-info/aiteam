import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthenticatedCaller } from "./auth.js";
import { encodeScope } from "../runtime-lease-cache.js";
import { appLogger } from "../observability.js";
import type { GatewayLocalContext, LocalContextOutcome } from "../services/gateway-local-context.js";
import { UpstreamUnavailableError, type UpstreamGateway } from "./upstream-gateway.js";

export const LOCAL_CONTEXT_HEADER = "X-Aiteam-Local-Context";
export const UPSTREAM_STATE_HEADER = "X-Aiteam-Upstream";

/**
 * Routes (Fastify templates) the desktop gateway answers locally. Prompt and
 * logout reach a local handler that preprocesses and then forwards; every
 * other contract `/api/**` route is streamed to the upstream Agent unchanged.
 * Unmatched URLs stay local (404 or SPA), so the gateway is never an open proxy.
 */
const LOCAL_ROUTES = new Set([
  "GET /api/agent/whoami",
  "POST /api/agent/grants/sync",
  "GET /api/agent/grants/readiness",
  "POST /api/agent/conversations/:conversation_id/prompt",
  "POST /api/agent/logout",
]);

export function isGatewayHandledRoute(method: string, url: string | undefined): boolean {
  if (!url || !url.startsWith("/api/")) return true;
  if (url === "/api/agent/local-directories" || url.startsWith("/api/agent/local-directories/") || url.startsWith("/api/agent/local-directory-citations/")) return true;
  return LOCAL_ROUTES.has(`${method === "HEAD" ? "GET" : method} ${url}`);
}

/** OpenAPI path keys whose local definition wins over the upstream document. */
function isLocalDocumentPath(path: string): boolean {
  return !path.startsWith("/api/") || ["/api/agent/whoami", "/api/agent/grants/sync", "/api/agent/grants/readiness"].includes(path)
    || path === "/api/agent/local-directories" || path.startsWith("/api/agent/local-directories/") || path.startsWith("/api/agent/local-directory-citations/");
}

export type OpenApiDocument = Record<string, unknown> & { paths?: Record<string, unknown>; components?: Record<string, Record<string, unknown> | undefined> };

export function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.openapi === "string" && !!record.paths && typeof record.paths === "object" && !Array.isArray(record.paths);
}

/**
 * Upstream document with local definitions for gateway-handled paths. Paths
 * only the local Agent knows are kept so host startup contract checks keep
 * passing against an older upstream; upstream components win on name clashes.
 */
export function mergeOpenApiDocuments(local: OpenApiDocument, upstream: OpenApiDocument): OpenApiDocument {
  const paths: Record<string, unknown> = { ...(upstream.paths ?? {}) };
  for (const [path, item] of Object.entries(local.paths ?? {})) {
    if (isLocalDocumentPath(path) || !(path in paths)) paths[path] = item;
  }
  const components: Record<string, Record<string, unknown>> = {};
  for (const name of new Set([...Object.keys(local.components ?? {}), ...Object.keys(upstream.components ?? {})])) {
    components[name] = { ...(local.components?.[name] ?? {}), ...(upstream.components?.[name] ?? {}) };
  }
  return { ...upstream, paths, components };
}

interface PreparedPrompt { owner: string; fingerprint: string; body: string; outcome: LocalContextOutcome; expires: number }
type Preparation =
  | { kind: "forward"; body: string; outcome: LocalContextOutcome; fingerprint?: string }
  | { kind: "receipt"; status: number; body: unknown };
interface ConversationTarget { owner: string; kind: string; employeeId: string | null; expires: number }

const PREPARED_TTL_MS = 24 * 60 * 60_000;
const MAX_PREPARED = 512;
const TARGET_TTL_MS = 60_000;

/**
 * Single-chat prompt preprocessing in gateway mode. The upstream receipt is
 * fingerprinted on the request body, and retrieval yields fresh citation IDs,
 * so the augmented body is cached per (tenant, member, conversation, key) and
 * reused on retries; after a restart the upstream receipt decides instead.
 */
export class GatewayPrompts {
  private readonly prepared = new Map<string, PreparedPrompt>();
  private readonly inflight = new Map<string, Promise<Preparation>>();
  private readonly targets = new Map<string, ConversationTarget>();

  constructor(private readonly upstream: UpstreamGateway, private readonly localContext?: GatewayLocalContext) {}

  async handle(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller | undefined, payload: Record<string, unknown>, writeJson: (status: number, body: unknown, contentType?: string) => void): Promise<void> {
    const original = JSON.stringify(payload);
    const key = header(request, "idempotency-key");
    const authorization = header(request, "authorization");
    const text = payload.text;
    const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
    let preparation: Preparation = { kind: "forward", body: original, outcome: "skipped" };
    if (caller && this.localContext && key && key.length <= 256 && authorization && typeof text === "string" && text.trim() && text.length <= 200_000 && mentions.length === 0) {
      const owner = ownerScope(caller);
      const scope = encodeScope([owner, conversationId, key]);
      const fingerprint = createHash("sha256").update(original).digest("hex");
      let pending = this.inflight.get(scope);
      if (!pending) {
        pending = this.prepare({ caller, owner, scope, conversationId, key, authorization, text, payload, original, fingerprint })
          .finally(() => this.inflight.delete(scope));
        this.inflight.set(scope, pending);
      }
      const shared = await pending;
      // A concurrent retry with a different body must reach upstream as-is so
      // its idempotency check reports the conflict.
      preparation = shared.kind === "forward" && shared.fingerprint !== undefined && shared.fingerprint !== fingerprint
        ? { kind: "forward", body: original, outcome: "skipped" }
        : shared;
    }
    if (response.destroyed) return;
    if (preparation.kind === "receipt") {
      writeJson(preparation.status, preparation.body, preparation.status >= 400 ? "application/problem+json; charset=utf-8" : undefined);
      return;
    }
    await this.upstream.forward(request, response, { body: preparation.body, responseHeaders: { [LOCAL_CONTEXT_HEADER]: preparation.outcome } });
  }

  /** Drop cached prompt bodies and conversation targets for a signed-out member. */
  forget(caller: AuthenticatedCaller): void {
    const owner = ownerScope(caller);
    for (const [key, value] of this.prepared) if (value.owner === owner) this.prepared.delete(key);
    for (const [key, value] of this.targets) if (value.owner === owner) this.targets.delete(key);
  }

  private async prepare(input: {
    caller: AuthenticatedCaller; owner: string; scope: string; conversationId: string; key: string; authorization: string;
    text: string; payload: Record<string, unknown>; original: string; fingerprint: string;
  }): Promise<Preparation> {
    this.prune();
    const cached = this.prepared.get(input.scope);
    if (cached) return { kind: "forward", body: cached.body, outcome: cached.outcome, fingerprint: cached.fingerprint };
    const skipped: Preparation = { kind: "forward", body: input.original, outcome: "skipped", fingerprint: input.fingerprint };
    const headers = { authorization: input.authorization };
    const target = await this.target(input.owner, input.conversationId, headers);
    if (!target || target.kind === "group" || !target.employeeId) return skipped;
    const context = this.localContext!.prepare(input.caller, target.employeeId, input.conversationId, input.key);
    if (!context) return skipped;
    // A retry whose augmented body was lost (e.g. Agent restart) cannot be
    // rebuilt byte-for-byte; answer from the upstream receipt instead.
    const path = `/api/agent/conversations/${encodeURIComponent(input.conversationId)}/receipts/${encodeURIComponent(input.key)}`;
    const receipt = await this.upstream.requestJson("GET", path, headers);
    if (receipt.status === 200) {
      const state = (receipt.body as { data?: { state?: unknown } } | undefined)?.data?.state;
      if (state === "completed" || state === "accepted") {
        return { kind: "receipt", status: 202, body: { data: { conversation_id: input.conversationId, accepted: true, state, idempotency_key: input.key } } };
      }
      return { kind: "receipt", status: 409, body: { type: "about:blank", title: "idempotency_unknown", status: 409, code: "idempotency_unknown", detail: "Prompt outcome is unknown and will not be replayed" } };
    }
    if (receipt.status === 401 || receipt.status === 403) return skipped;
    const augmented = await this.localContext!.augment(context, input.text);
    const used = /^used=(\d+)$/u.exec(augmented.outcome);
    appLogger.log("info", "gateway.local_context", used ? { outcome: "used", count: Number(used[1]) } : { outcome: augmented.outcome });
    const body = augmented.text === input.text ? input.original : JSON.stringify({ ...input.payload, text: augmented.text });
    const prepared: PreparedPrompt = { owner: input.owner, fingerprint: input.fingerprint, body, outcome: augmented.outcome, expires: Date.now() + PREPARED_TTL_MS };
    this.prepared.set(input.scope, prepared);
    while (this.prepared.size > MAX_PREPARED) this.prepared.delete(this.prepared.keys().next().value!);
    return { kind: "forward", body, outcome: augmented.outcome, fingerprint: input.fingerprint };
  }

  private async target(owner: string, conversationId: string, headers: Record<string, string>): Promise<ConversationTarget | undefined> {
    const scope = encodeScope([owner, conversationId]);
    const cached = this.targets.get(scope);
    if (cached && cached.expires > Date.now()) return cached;
    let result;
    try {
      result = await this.upstream.requestJson("GET", `/api/agent/conversations/${encodeURIComponent(conversationId)}`, headers);
    } catch (error) {
      if (error instanceof UpstreamUnavailableError) throw error;
      return undefined;
    }
    const data = (result.body as { data?: { kind?: unknown; entry_employee_id?: unknown } } | undefined)?.data;
    if (result.status !== 200 || !data || typeof data.kind !== "string") return undefined;
    const target: ConversationTarget = { owner, kind: data.kind, employeeId: typeof data.entry_employee_id === "string" ? data.entry_employee_id : null, expires: Date.now() + TARGET_TTL_MS };
    this.targets.set(scope, target);
    if (this.targets.size > MAX_PREPARED) this.targets.delete(this.targets.keys().next().value!);
    return target;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.prepared) if (value.expires <= now) this.prepared.delete(key);
  }
}

function ownerScope(caller: AuthenticatedCaller): string {
  return encodeScope([caller.tenantId ?? "", caller.userId ?? caller.callerId]);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}
