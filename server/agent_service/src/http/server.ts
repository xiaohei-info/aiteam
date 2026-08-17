import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ConversationBusyError, EventCursorStaleError, InvalidEventCursorError, type PiEventEnvelope, SessionHost } from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IdempotencyConflictError, IdempotencyUnknownError, type AgentSqliteStore } from "../storage/sqlite.js";
import type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";
import { ManagerAuthError, ManagerUnavailableError, type ManagerClient } from "../manager-client.js";
import type { ConversationState, LoadedExpertProjection } from "../storage/sqlite.js";
export type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface AgentHttpServerOptions {
  host: SessionHost;
  store: AgentSqliteStore;
  authenticate: AuthenticateRequest;
  runtimeReady?: () => boolean | Promise<boolean>;
  managerClient?: ManagerClient;
  logger?: Pick<Console, "error">;
}

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors?: unknown) {
    super(message);
    this.name = "HttpProblem";
  }
}

export class AgentHttpServer {
  readonly server: Server;

  constructor(private readonly options: AgentHttpServerOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) return resolve();
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = this.header(request, "x-request-id") ?? randomUUID();
    response.setHeader("X-Request-ID", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") return this.writeJson(response, 200, { data: { status: "ok" } });
      if (request.method === "GET" && url.pathname === "/readyz") {
        let ready = false;
        try {
          this.options.store.db.prepare("SELECT 1").get();
          ready = (await this.options.runtimeReady?.()) ?? true;
        } catch {
          ready = false;
        }
        return this.writeJson(response, ready ? 200 : 503, { data: { ready } });
      }
      if (request.method === "GET" && url.pathname === "/openapi.json") return this.writeJson(response, 200, OPENAPI);
      if (request.method === "GET" && url.pathname === "/docs") return this.writeHtml(response, swaggerHtml("/openapi.json"));
      if (request.method === "GET" && url.pathname === "/redoc") return this.writeHtml(response, redocHtml("/openapi.json"));

      const route = this.matchConversationRoute(url.pathname);
      const platformRoute = this.matchPlatformRoute(url.pathname);
      if (!route && !platformRoute) throw new HttpProblem(404, "not_found", "Route not found");
      if (platformRoute === "login" && request.method === "POST") return await this.login(request, response);
      if (platformRoute === "reset-password" && request.method === "POST") return await this.resetPassword(request, response);
      let caller: AuthenticatedCaller;
      try {
        caller = await this.options.authenticate(request);
      } catch {
        throw new HttpProblem(401, "unauthenticated", "Authentication is required");
      }
      if (!caller.callerId) throw new HttpProblem(401, "unauthenticated", "Authenticated caller is required");

      if (
        platformRoute === "gone" ||
        (platformRoute === "marketplace" && request.method !== "GET") ||
        (platformRoute === "knowledge-bases" && request.method !== "GET") ||
        (platformRoute === "knowledge-read" && request.method !== "GET")
      ) throw new HttpProblem(410, "gone", "This Agent endpoint was removed; use Manager-authorized read projections or the Pi prompt API");
      if (platformRoute === "ping" && request.method === "GET") return this.writeJson(response, 200, { data: { pong: true } });
      if (platformRoute === "whoami" && request.method === "GET") return this.writeJson(response, 200, { data: caller.claims ?? { user_id: caller.userId ?? caller.callerId, tenant_id: caller.tenantId ?? null, roles: caller.roles ?? [] } });
      if (platformRoute === "conversations" && request.method === "GET") return this.listConversations(response, url.searchParams);
      if (platformRoute === "conversations" && request.method === "POST") return await this.createConversation(request, response);
      if (platformRoute === "conversation" && request.method === "GET") return this.getConversation(response, url.pathname);
      if (platformRoute === "conversation" && (request.method === "PATCH" || request.method === "PUT")) return await this.updateConversation(request, response, url.pathname);
      if (platformRoute === "conversation" && request.method === "DELETE") return this.deleteConversation(response, url.pathname);
      if (platformRoute === "state" && request.method === "GET") return this.getConversationState(response, url.pathname);
      if (platformRoute === "state" && request.method === "PUT") return await this.updateConversationState(request, response, url.pathname);
      if (platformRoute === "experts" && request.method === "GET") return this.listExperts(response);
      if (platformRoute === "solutions" && request.method === "GET") return this.listSolutions(response);
      if (platformRoute === "snapshots" && request.method === "GET") return this.listSnapshots(response);
      if (platformRoute === "readiness" && request.method === "GET") return await this.readiness(response);
      if (platformRoute === "expert-readiness" && request.method === "GET") return await this.expertReadiness(response, url.pathname);
      if (platformRoute === "sync" && request.method === "POST") return await this.syncGrants(request, response, caller);
      if (platformRoute === "outbox" && request.method === "GET") return this.listOutbox(response);
      if (platformRoute === "marketplace" && request.method === "GET") return this.listMarketplaceTemplates(response);
      if (platformRoute === "knowledge-bases" && request.method === "GET") return this.listKnowledgeBases(response);
      if (platformRoute === "knowledge-read" && request.method === "GET") return this.listKnowledgeReadModel(response);
      if (platformRoute === "org" && request.method === "GET") return await this.orgTree(response, caller);
      if (platformRoute === "office-scene" && request.method === "GET") return this.officeScene(response);
      if (platformRoute === "office-feed" && request.method === "GET") return this.officeFeed(response);

      if (!route) throw new HttpProblem(405, "method_not_allowed", "Method not allowed");
      if (route.action === "events" && request.method === "GET") {
        return await this.events(request, response, route.conversationId, url.searchParams.get("after"));
      }
      if (route.action === "entries" && request.method === "GET") {
        const entries = await this.options.host.entries(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, entries } });
      }
      if (route.action === "prompt" && request.method === "POST") return await this.prompt(request, response, route.conversationId, caller.callerId);
      if (route.action === "abort" && request.method === "POST") {
        const aborted = await this.options.host.abort(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, aborted } });
      }
      throw new HttpProblem(405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
      this.writeError(response, error, requestId);
    }
  }

  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.login) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is not configured");
    const body = await this.readJson(request);
    const tenantId = this.stringField(body.tenant_id, "tenant_id", 200);
    const account = this.stringField(body.account, "account", 256);
    const password = this.stringField(body.password, "password", 512);
    try {
      const payload = await this.options.managerClient.login({ tenant_id: tenantId, account, password });
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "authentication_failed", typeof body?.detail === "string" ? body.detail : "Manager authentication failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is unavailable");
      throw error;
    }
  }

  private async resetPassword(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.ownerReset) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is not configured");
    const body = await this.readJson(request);
    const input = {
      tenant_id: this.stringField(body.tenant_id, "tenant_id", 200),
      account: this.stringField(body.account, "account", 256),
      old_password: this.stringField(body.old_password, "old_password", 512),
      new_password: this.stringField(body.new_password, "new_password", 512),
    };
    try {
      const payload = await this.options.managerClient.ownerReset(input);
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "password_reset_failed", typeof body?.detail === "string" ? body.detail : "Manager password reset failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager authentication is unavailable");
      throw error;
    }
  }

  private listConversations(response: ServerResponse, query: URLSearchParams): void {
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(422, "invalid_limit", "limit must be an integer between 1 and 100");
    const cursor = query.get("cursor") ?? undefined;
    if (cursor !== undefined && !this.options.store.getConversationMetadata(cursor)) throw new HttpProblem(422, "invalid_cursor", "cursor does not identify a conversation");
    const result = this.options.store.listConversations(limit, cursor);
    this.writeJson(response, 200, { data: { items: result.items, page: { next_cursor: result.nextCursor, has_more: result.hasMore } } });
  }

  private async createConversation(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson(request);
    const title = body.title === undefined || body.title === null ? null : this.stringField(body.title, "title", 200);
    const kind = body.kind === undefined ? "chat" : this.stringField(body.kind, "kind", 64);
    const labels = body.labels === undefined ? [] : this.stringArray(body.labels, "labels", 32);
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : randomUUID();
    if (this.options.store.getConversationMetadata(id)) throw new HttpProblem(409, "conversation_exists", "Conversation already exists");
    const metadata = this.options.store.createConversation({
      id, title, kind, labels, state: "active",
      entryEmployeeId: this.optionalString(body.entry_employee_id, "entry_employee_id"),
      coordinatorEmployeeId: this.optionalString(body.coordinator_employee_id, "coordinator_employee_id"),
      solutionRef: this.optionalString(body.solution_instance_id, "solution_instance_id"),
    });
    this.writeJson(response, 201, { data: metadata });
  }

  private getConversationId(pathname: string): string {
    const match = pathname.match(/^\/api\/agent\/conversations\/([^/]+)/);
    if (!match) throw new HttpProblem(404, "not_found", "Conversation not found");
    return decodeURIComponent(match[1]);
  }

  private getConversation(response: ServerResponse, pathname: string): void {
    const metadata = this.options.store.getConversationMetadata(this.getConversationId(pathname));
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: metadata });
  }

  private async updateConversation(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const body = await this.readJson(request);
    const patch: Parameters<AgentSqliteStore["updateConversation"]>[1] = {};
    if (body.title !== undefined) patch.title = body.title === null ? null : this.stringField(body.title, "title", 200);
    if (body.kind !== undefined) patch.kind = this.stringField(body.kind, "kind", 64);
    if (body.labels !== undefined) patch.labels = this.stringArray(body.labels, "labels", 32);
    if (body.schedule !== undefined) patch.schedule = body.schedule === null ? null : this.objectField(body.schedule, "schedule");
    if (body.last_read_entry_id !== undefined) patch.lastReadEntryId = this.optionalString(body.last_read_entry_id, "last_read_entry_id");
    const updated = this.options.store.updateConversation(this.getConversationId(pathname), patch);
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private getConversationState(response: ServerResponse, pathname: string): void {
    const metadata = this.options.store.getConversationMetadata(this.getConversationId(pathname));
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { conversation_id: metadata.id, state: metadata.state } });
  }

  private async updateConversationState(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const body = await this.readJson(request);
    const state = this.stringField(body.state, "state", 32) as ConversationState;
    if (!["draft", "active", "paused", "muted", "archived"].includes(state)) throw new HttpProblem(422, "invalid_state", "Unsupported conversation state");
    const updated = this.options.store.updateConversation(this.getConversationId(pathname), { state });
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private deleteConversation(response: ServerResponse, pathname: string): void {
    if (!this.options.store.deleteConversation(this.getConversationId(pathname))) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { deleted: true } });
  }

  private listExperts(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: this.options.store.listLoadedExperts(), page: { next_cursor: null, has_more: false } } }); }
  private listSolutions(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: this.options.store.listSolutions(), page: { next_cursor: null, has_more: false } } }); }
  private listMarketplaceTemplates(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: [], page: { next_cursor: null, has_more: false } } }); }
  private listKnowledgeBases(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: [], page: { next_cursor: null, has_more: false } } }); }
  private listKnowledgeReadModel(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: [], page: { next_cursor: null, has_more: false } } }); }
  private listSnapshots(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: this.options.store.listSnapshots(), page: { next_cursor: null, has_more: false } } }); }
  private listOutbox(response: ServerResponse): void { this.writeJson(response, 200, { data: { items: this.options.store.listUsageOutbox(), page: { next_cursor: null, has_more: false } } }); }

  private async syncGrants(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient) throw new HttpProblem(503, "manager_unavailable", "Manager sync is not configured");
    const body = await this.readJson(request);
    const tenantId = this.stringField(body.tenant_id, "tenant_id", 200);
    const memberId = this.stringField(body.member_id, "member_id", 200);
    if (tenantId !== caller.tenantId || memberId !== (caller.userId ?? caller.callerId)) throw new HttpProblem(403, "forbidden", "Sync identity does not match authenticated caller");
    const knownVersions = body.known_versions === undefined ? {} : this.objectField(body.known_versions, "known_versions");
    try {
      const config = await this.options.managerClient.pullAuthorizedConfig(caller, knownVersions as Record<string, string>);
      const snapshots = config.snapshots ?? (this.options.managerClient.pullSnapshots ? await this.options.managerClient.pullSnapshots(caller, config.experts ?? []) : []);
      const result = this.options.store.replaceProjections(config.experts ?? [], config.solutions ?? [], snapshots, config.revoked_ids ?? []);
      this.writeJson(response, 200, { data: { ok: true, ...result } });
    } catch (error) {
      if (error instanceof ManagerUnavailableError || error instanceof TypeError) throw new HttpProblem(503, "manager_unavailable", "Manager sync is unavailable");
      throw error;
    }
  }

  private async readiness(response: ServerResponse): Promise<void> {
    const runtime = (await this.options.runtimeReady?.()) ?? true;
    const state = runtime ? "ready" : "blocked";
    const experts = this.options.store.listLoadedExperts().map((expert) => this.expertReadinessValue(expert, runtime));
    this.writeJson(response, 200, { data: { runtime: state, runtime_reason: runtime ? undefined : "Pi runtime is not ready", experts } });
  }

  private async expertReadiness(response: ServerResponse, pathname: string): Promise<void> {
    const id = decodeURIComponent(pathname.split("/").at(-2) ?? "");
    const expert = this.options.store.listLoadedExperts().find((item) => item.employee_id === id);
    if (!expert) return this.writeJson(response, 200, { data: { employee_id: id, display_name: id, handle: id, available: false, runtime: "unknown", provider: "unknown", skills: [], capabilities: [], reasons: ["Expert is not authorized locally"] } });
    const runtime = (await this.options.runtimeReady?.()) ?? true;
    this.writeJson(response, 200, { data: this.expertReadinessValue(expert, runtime) });
  }

  private expertReadinessValue(expert: LoadedExpertProjection, runtime: boolean) {
    const provider = expert.model_policy && (expert.model_policy.model || expert.model_policy.provider_ref) ? "ready" : "blocked";
    return { employee_id: expert.employee_id, display_name: expert.display_name, handle: expert.handle, available: runtime && provider === "ready", runtime: runtime ? "ready" : "blocked", provider, skills: [], capabilities: [], reasons: [ ...(runtime ? [] : ["Pi runtime is not ready"]), ...(provider === "ready" ? [] : ["Manager snapshot has no model provider"]) ] };
  }

  private async orgTree(response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient) throw new HttpProblem(503, "manager_unavailable", "Organization projection is unavailable");
    try { this.writeJson(response, 200, { data: await this.options.managerClient.getOrgTree(caller) }); }
    catch { throw new HttpProblem(503, "manager_unavailable", "Organization projection is unavailable"); }
  }

  private officeScene(response: ServerResponse): void {
    const employees = this.options.store.listLoadedExperts().map((expert) => ({ employee_id: expert.employee_id, display_name: expert.display_name, status: expert.revoked ? "offline" : "ready", task: null, avatar_url: typeof expert.avatar_url === "string" ? expert.avatar_url : null }));
    const summary = { total: employees.length, working: 0, ready: employees.filter((employee) => employee.status === "ready").length, offline: employees.filter((employee) => employee.status === "offline").length };
    this.writeJson(response, 200, { data: { employees, summary } });
  }

  private officeFeed(response: ServerResponse): void { this.writeJson(response, 200, { data: { events: [] } }); }

  private stringField(value: unknown, name: string, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpProblem(422, `invalid_${name}`, `${name} must be a non-empty string <= ${max} characters`); return value; }
  private optionalString(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; return this.stringField(value, name, 256); }
  private stringArray(value: unknown, name: string, maxItems: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 128)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an array of strings`); return value as string[]; }
  private objectField(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an object`); return value as Record<string, unknown>; }

  private async prompt(request: IncomingMessage, response: ServerResponse, conversationId: string, callerId: string): Promise<void> {
    const key = this.header(request, "idempotency-key");
    if (!key || key.length > 256) throw new HttpProblem(422, "invalid_idempotency_key", "Idempotency-Key is required and must be <= 256 characters");
    const payload = await this.readJson(request);
    const text = payload.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 200_000) {
      throw new HttpProblem(422, "invalid_prompt", "text must be a non-empty string <= 200000 characters");
    }
    const images = payload.images;
    if (images !== undefined && (!Array.isArray(images) || images.length > 8 || images.some((image) => !image || typeof image !== "object" || (image as Record<string, unknown>).type !== "image" || typeof (image as Record<string, unknown>).data !== "string" || typeof (image as Record<string, unknown>).mimeType !== "string"))) {
      throw new HttpProblem(422, "invalid_images", "images must contain at most 8 {type, data, mimeType} objects");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ text, images: images ?? [] })).digest("hex");
    const receipt = this.options.store.reservePrompt({ conversationId, callerId, key, fingerprint });
    if (!receipt.isNew) return this.writeReceipt(response, conversationId, key, receipt.state);

    void this.runPrompt(conversationId, callerId, key, receipt.ownerInstance, text, images);
    this.writeReceipt(response, conversationId, key, "accepted");
  }

  private async runPrompt(conversationId: string, callerId: string, key: string, ownerInstance: string | undefined, text: string, images: unknown): Promise<void> {
    const heartbeat = setInterval(() => this.options.store.renewLease(conversationId, callerId, key, ownerInstance), 10_000);
    try {
      const lastEntryId = await this.options.host.prompt(conversationId, text, this.asImages(images));
      this.options.store.markCompleted(conversationId, callerId, key, lastEntryId, ownerInstance);
    } catch (error) {
      this.options.store.markUnknown(conversationId, callerId, key, ownerInstance);
      this.options.logger?.error(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async events(request: IncomingMessage, response: ServerResponse, conversationId: string, after: string | null): Promise<void> {
    const requested = after ?? this.header(request, "last-event-id");
    let closed = false;
    let started = false;
    const pending: PiEventEnvelope[] = [];
    const write = (envelope: PiEventEnvelope) => {
      if (closed) return;
      if (!started) return pending.push(envelope), undefined;
      if (!response.writableEnded) response.write(`id: ${envelope.id}\nevent: pi\ndata: ${JSON.stringify(envelope.event)}\n\n`);
    };
    const unsubscribe = await this.options.host.subscribe(conversationId, write, requested ?? undefined);
    response.writeHead(200, { "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    response.write(": connected\n\n");
    started = true;
    for (const envelope of pending) write(envelope);
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    request.once("close", close);
    response.once("close", close);
  }

  private matchPlatformRoute(pathname: string): string | undefined {
    if (pathname === "/api/agent/login") return "login";
    if (pathname === "/api/agent/reset-password") return "reset-password";
    if (pathname === "/api/agent/ping") return "ping";
    if (pathname === "/api/agent/whoami") return "whoami";
    if (pathname === "/api/agent/conversations") return "conversations";
    if (/^\/api\/agent\/conversations\/[^/]+$/.test(pathname)) return "conversation";
    if (/^\/api\/agent\/conversations\/[^/]+\/state$/.test(pathname)) return "state";
    if (pathname === "/api/agent/grants/experts") return "experts";
    if (pathname === "/api/agent/grants/solutions") return "solutions";
    if (pathname === "/api/agent/grants/snapshots") return "snapshots";
    if (pathname === "/api/agent/grants/readiness") return "readiness";
    if (/^\/api\/agent\/grants\/experts\/[^/]+\/readiness$/.test(pathname)) return "expert-readiness";
    if (pathname === "/api/agent/grants/sync") return "sync";
    if (pathname === "/api/agent/usage/outbox") return "outbox";
    if (pathname === "/api/agent/marketplace/templates" || /^\/api\/agent\/marketplace\/templates\/[^/]+$/.test(pathname)) return "marketplace";
    if (pathname === "/api/agent/knowledge-bases") return "knowledge-bases";
    if (/^\/api\/agent\/knowledge-bases\/[^/]+\/(search|documents|ingestions)(\/[^/]+)?$/.test(pathname)) return "knowledge-read";
    if (pathname === "/api/agent/org/tree") return "org";
    if (pathname === "/api/agent/office/scene") return "office-scene";
    if (pathname === "/api/agent/office/feed") return "office-feed";
    if (/^\/api\/agent\/conversations\/[^/]+\/(group-dispatch|terminal\/execute)$/.test(pathname) || pathname.startsWith("/api/agent/recruitments") || pathname.startsWith("/api/agent/knowledge-bases/")) return "gone";
    return undefined;
  }

  private matchConversationRoute(pathname: string): { conversationId: string; action: "prompt" | "events" | "abort" | "entries" } | undefined {
    const match = pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/(prompt|events|abort|entries)$/);
    if (!match) return undefined;
    return { conversationId: decodeURIComponent(match[1]), action: match[2] as "prompt" | "events" | "abort" | "entries" };
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new HttpProblem(413, "request_too_large", "Request body is too large");
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
      return value as Record<string, unknown>;
    } catch {
      throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
    }
  }

  private asImages(value: unknown): ImageContent[] | undefined {
    return Array.isArray(value) ? value as ImageContent[] : undefined;
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private writeReceipt(response: ServerResponse, conversationId: string, key: string, state: string): void {
    this.writeJson(response, 202, { data: { conversation_id: conversationId, accepted: true, state, idempotency_key: key } });
  }

  private writeJson(response: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
    if (response.writableEnded) return;
    const payload = JSON.stringify(body);
    response.writeHead(status, { "Content-Length": Buffer.byteLength(payload), "Content-Type": contentType });
    response.end(payload);
  }

  private writeHtml(response: ServerResponse, html: string): void {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  }

  private writeError(response: ServerResponse, error: unknown, requestId: string): void {
    if (response.writableEnded) return;
    let problem: { status: number; code: string; detail: string; errors?: unknown };
    if (error instanceof HttpProblem) problem = { status: error.status, code: error.code, detail: error.message, errors: error.errors };
    else if (error instanceof IdempotencyConflictError) problem = { status: 409, code: "idempotency_conflict", detail: error.message };
    else if (error instanceof IdempotencyUnknownError) problem = { status: 409, code: "idempotency_unknown", detail: error.message };
    else if (error instanceof EventCursorStaleError) problem = { status: 409, code: "stale_cursor", detail: error.message };
    else if (error instanceof InvalidEventCursorError) problem = { status: 422, code: "invalid_cursor", detail: error.message };
    else problem = { status: 500, code: "internal_error", detail: "Internal server error" };
    this.writeJson(response, problem.status, { type: "about:blank", title: problem.code, status: problem.status, code: problem.code, detail: problem.detail, instance: requestId, request_id: requestId, ...(problem.errors ? { errors: problem.errors } : {}) }, "application/problem+json; charset=utf-8");
  }
}

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "AI Team Agent Service", version: "0.1.0" },
  paths: {
    "/healthz": { get: { operationId: "healthz", responses: { "200": { description: "Alive" } } } },
    "/readyz": { get: { operationId: "readyz", responses: { "200": { description: "Ready" }, "503": { description: "Not ready" } } } },
    "/api/agent/conversations/{conversation_id}/prompt": { post: { operationId: "promptConversation", parameters: [{ name: "conversation_id", in: "path", required: true }], responses: { "202": { description: "Accepted" }, "409": { description: "Conflict" }, "422": { description: "Validation error" } } } },
    "/api/agent/conversations/{conversation_id}/events": { get: { operationId: "subscribeConversationEvents", parameters: [{ name: "conversation_id", in: "path", required: true }, { name: "after", in: "query" }], responses: { "200": { description: "Pi event stream" } } } },
    "/api/agent/conversations/{conversation_id}/entries": { get: { operationId: "listConversationEntries", responses: { "200": { description: "Pi entries" } } } },
    "/api/agent/conversations": { get: { operationId: "listConversations", responses: { "200": { description: "Conversation metadata" } } }, post: { operationId: "createConversation", responses: { "201": { description: "Conversation metadata" } } } },
    "/api/agent/conversations/{conversation_id}": { get: { operationId: "getConversation", responses: { "200": { description: "Conversation metadata" } } }, patch: { operationId: "updateConversation", responses: { "200": { description: "Conversation metadata" } } }, delete: { operationId: "deleteConversation", responses: { "200": { description: "Deleted" } } } },
    "/api/agent/conversations/{conversation_id}/state": { put: { operationId: "setConversationState", responses: { "200": { description: "Conversation metadata" } } } },
    "/api/agent/login": { post: { operationId: "login", responses: { "200": { description: "Manager-issued token" }, "401": { description: "Authentication failed" } } } },
    "/api/agent/reset-password": { post: { operationId: "resetPassword", responses: { "200": { description: "Manager-issued token" }, "401": { description: "Reset failed" } } } },
    "/api/agent/ping": { get: { operationId: "ping", responses: { "200": { description: "Pong" } } } },
    "/api/agent/whoami": { get: { operationId: "whoami", responses: { "200": { description: "Authenticated caller" } } } },
    "/api/agent/grants/experts": { get: { operationId: "listAuthorizedExperts", responses: { "200": { description: "Local projection" } } } },
    "/api/agent/grants/solutions": { get: { operationId: "listAuthorizedSolutions", responses: { "200": { description: "Local projection" } } } },
    "/api/agent/grants/snapshots": { get: { operationId: "listFrozenSnapshots", responses: { "200": { description: "Frozen snapshots" } } } },
    "/api/agent/grants/readiness": { get: { operationId: "grantsReadiness", responses: { "200": { description: "Readiness" } } } },
    "/api/agent/grants/experts/{employee_id}/readiness": { get: { operationId: "expertReadiness", responses: { "200": { description: "Readiness" } } } },
    "/api/agent/grants/sync": { post: { operationId: "syncGrants", responses: { "200": { description: "Sync result" }, "503": { description: "Manager unavailable" } } } },
    "/api/agent/usage/outbox": { get: { operationId: "listUsageOutbox", responses: { "200": { description: "Usage summaries" } } } },
    "/api/agent/marketplace/templates": { get: { operationId: "listMarketplaceTemplates", responses: { "200": { description: "Read-only catalog projection" } } } },
    "/api/agent/knowledge-bases": { get: { operationId: "listKnowledgeBases", responses: { "200": { description: "Read-only knowledge projection" } } } },
    "/api/agent/org/tree":  { get: { operationId: "orgTree", responses: { "200": { description: "Organization tree" } } } },
    "/api/agent/office/scene": { get: { operationId: "officeScene", responses: { "200": { description: "Office scene" } } } },
    "/api/agent/office/feed": { get: { operationId: "officeFeed", responses: { "200": { description: "Office feed" } } } },
  },
};

function swaggerHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><div id="app"></div><script>SwaggerUIBundle({url:${JSON.stringify(url)},dom_id:'#app'})</script>`;
}
function redocHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><redoc spec-url=${JSON.stringify(url)}></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>`;
}
