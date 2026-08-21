import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import { ConversationBusyError, EventCursorStaleError, InvalidEventCursorError, type PiEventEnvelope, SessionHost } from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IdempotencyConflictError, IdempotencyUnknownError, type AgentSqliteStore } from "../storage/sqlite.js";
import type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";
import { ManagerAuthError, ManagerUnavailableError, normalizeAuthorizedConfig, normalizeKnowledgeArtifact, type ManagerClient } from "../manager-client.js";
import { SessionAuthorizationError } from "../pi/session-host.js";
import { serializePiEvent } from "../pi/event-sse.js";
import type { ConversationState, KnowledgeArtifact, LoadedExpertProjection, LocalFileKind } from "../storage/sqlite.js";
import { validateSchedule } from "../schedule.js";
import type { UsageFlushService } from "../usage-flush.js";
import { SkillCache, SkillVerificationError, skillRefsForSnapshot, verifySignedSkillPackage } from "../skills.js";
export type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOCAL_FILE_NAME = 255;
const MAX_PROMPT_IMAGES = 8;
const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_JSON_BYTES = Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4 + 64 * 1024;
const ALLOWED_FILE_MIMES = new Set([
  "application/json", "application/pdf", "application/octet-stream", "image/gif", "image/jpeg", "image/png", "image/webp", "text/markdown", "text/plain",
]);
const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export interface AgentHttpServerOptions {
  host: SessionHost;
  store: AgentSqliteStore;
  authenticate: AuthenticateRequest;
  runtimeReady?: () => boolean | Promise<boolean>;
  localReady?: () => boolean | Promise<boolean>;
  managerClient?: ManagerClient;
  logger?: Pick<Console, "error">;
  spaRoot?: string;
  usageFlush?: UsageFlushService;
  skillCache?: SkillCache;
}

export class HttpProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors?: unknown) {
    super(message);
    this.name = "HttpProblem";
  }
}

export class AgentHttpServer {
  readonly server: Server;
  private requests = 0;
  private errors = 0;
  private readonly promptWorkers = new Set<Promise<void>>();

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

  async close(): Promise<void> {
    await this.options.host.abortAll();
    await Promise.allSettled([...this.promptWorkers]);
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requests += 1;
    const requestId = this.header(request, "x-request-id") ?? randomUUID();
    response.setHeader("X-Request-ID", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") return this.writeJson(response, 200, { data: { status: "ok" } });
      if (request.method === "GET" && url.pathname === "/metrics") return this.writeMetrics(response);
      if (request.method === "GET" && url.pathname === "/readyz") {
        let ready = false;
        try {
          this.options.store.db.prepare("SELECT 1").get();
          ready = (await this.options.localReady?.()) ?? true;
        } catch { ready = false; }
        return this.writeJson(response, ready ? 200 : 503, { data: { ready } });
      }
      if (request.method === "GET" && url.pathname === "/openapi.json") return this.writeJson(response, 200, OPENAPI);
      if (request.method === "GET" && url.pathname === "/docs") return this.writeHtml(response, swaggerHtml("/openapi.json"));
      if (request.method === "GET" && url.pathname === "/redoc") return this.writeHtml(response, redocHtml("/openapi.json"));

      const route = this.matchConversationRoute(url.pathname);
      const platformRoute = this.matchPlatformRoute(url.pathname);
      const publicAuthRoute = url.pathname === "/api/auth/resolve-tenant-by-account";
      if (!route && !platformRoute && !publicAuthRoute) {
        if (request.method === "GET" && this.serveSpa(url.pathname, response)) return;
        throw new HttpProblem(404, "not_found", "Route not found");
      }
      if (url.pathname === "/api/auth/resolve-tenant-by-account" && request.method === "POST") return await this.resolveTenantByAccount(request, response);
      if (platformRoute === "login" && request.method === "POST") return await this.login(request, response);
      if (platformRoute === "reset-password" && request.method === "POST") return await this.resetPassword(request, response);
      let caller: AuthenticatedCaller;
      try {
        caller = await this.options.authenticate(request);
      } catch {
        throw new HttpProblem(401, "unauthenticated", "Authentication is required");
      }
      if (!caller.callerId || !caller.tenantId || !(caller.userId ?? caller.callerId)) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant and member are required");

      if (
        platformRoute === "gone" ||
        (platformRoute === "marketplace" && request.method !== "GET") ||
        (platformRoute === "knowledge-bases" && request.method !== "GET") ||
        (platformRoute === "knowledge-read" && request.method !== "GET")
      ) throw new HttpProblem(410, "gone", "This Agent endpoint was removed; use Manager-authorized read projections or the Pi prompt API");
      if (platformRoute === "ping" && request.method === "GET") return this.writeJson(response, 200, { data: { pong: true } });
      if (platformRoute === "whoami" && request.method === "GET") return this.writeJson(response, 200, { data: caller.claims ?? { user_id: caller.userId ?? caller.callerId, tenant_id: caller.tenantId ?? null, roles: caller.roles ?? [] } });
      if (platformRoute === "conversations" && request.method === "GET") return this.listConversations(response, url.searchParams, caller);
      if (platformRoute === "conversations" && request.method === "POST") return await this.createConversation(request, response, caller);
      if (platformRoute === "conversation" && request.method === "GET") return this.getConversation(response, url.pathname, caller);
      if (platformRoute === "conversation" && (request.method === "PATCH" || request.method === "PUT")) return await this.updateConversation(request, response, url.pathname, caller);
      if (platformRoute === "conversation" && request.method === "DELETE") return await this.deleteConversation(response, url.pathname, caller);
      if (route?.action === "files" && request.method === "GET") return this.listLocalFiles(response, route, caller);
      if (route?.action === "files" && request.method === "POST") return await this.uploadLocalFile(request, response, route, caller);
      if (route?.action === "file" && request.method === "GET") return this.downloadLocalFile(response, route, caller);
      if (route?.action === "file" && request.method === "DELETE") return this.deleteLocalFile(response, route, caller);
      if (platformRoute === "state" && request.method === "GET") return this.getConversationState(response, url.pathname, caller);
      if (platformRoute === "state" && request.method === "PUT") return await this.updateConversationState(request, response, url.pathname, caller);
      if (platformRoute === "experts" && request.method === "GET") return this.listExperts(response, caller);
      if (platformRoute === "solutions" && request.method === "GET") return this.listSolutions(response, caller);
      if (platformRoute === "snapshots" && request.method === "GET") return this.listSnapshots(response, caller);
      if (platformRoute === "readiness" && request.method === "GET") return await this.readiness(response, caller);
      if (platformRoute === "expert-readiness" && request.method === "GET") return await this.expertReadiness(response, url.pathname, caller);
      if (platformRoute === "sync" && request.method === "POST") return await this.syncGrants(request, response, caller);
      if (platformRoute === "outbox" && request.method === "GET") return this.listOutbox(response, caller);
      if (platformRoute === "usage-flush" && request.method === "POST") return await this.flushUsage(request, response, caller);
      if (platformRoute === "marketplace" && request.method === "GET") return this.listMarketplaceTemplates(response);
      if (platformRoute === "knowledge-bases" && request.method === "GET") return this.listKnowledgeBases(response);
      if (platformRoute === "knowledge-read" && request.method === "GET") return this.listKnowledgeReadModel(response);
      if (platformRoute === "org" && request.method === "GET") return await this.orgTree(response, caller);
      if (platformRoute === "office-scene" && request.method === "GET") return this.officeScene(response, caller);
      if (platformRoute === "office-feed" && request.method === "GET") return this.officeFeed(response);

      if (!route) throw new HttpProblem(405, "method_not_allowed", "Method not allowed");
      if (route.action === "events" && request.method === "GET") {
        this.requireOwnedConversation(route.conversationId, caller);
        return await this.events(request, response, route.conversationId, url.searchParams.get("after"));
      }
      if (route.action === "entries" && request.method === "GET") {
        this.requireOwnedConversation(route.conversationId, caller);
        const entries = await this.options.host.entries(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, entries } });
      }
      if (route.action === "prompt" && request.method === "POST") {
        this.requireOwnedConversation(route.conversationId, caller);
        return await this.prompt(request, response, route.conversationId, caller);
      }
      if (route.action === "abort" && request.method === "POST") {
        this.requireOwnedConversation(route.conversationId, caller);
        const aborted = await this.options.host.abort(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, aborted } });
      }
      throw new HttpProblem(405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      this.errors += 1;
      if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
      this.writeError(response, error, requestId);
    }
  }

  private async resolveTenantByAccount(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.managerClient?.resolveTenantByAccount) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is not configured");
    const body = await this.readJson(request);
    const account = this.stringField(body.account, "account", 256);
    try {
      const payload = await this.options.managerClient.resolveTenantByAccount(account);
      this.writeJson(response, 200, payload);
    } catch (error) {
      if (error instanceof ManagerAuthError) {
        const body = error.body && typeof error.body === "object" ? error.body as Record<string, unknown> : undefined;
        throw new HttpProblem(error.status, typeof body?.code === "string" ? body.code : "tenant_resolution_failed", typeof body?.detail === "string" ? body.detail : "Manager tenant resolution failed", body?.errors);
      }
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Manager tenant resolution is unavailable");
      throw error;
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

  private listConversations(response: ServerResponse, query: URLSearchParams, caller: AuthenticatedCaller): void {
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(422, "invalid_limit", "limit must be an integer between 1 and 100");
    const cursor = query.get("cursor") ?? undefined;
    if (cursor !== undefined && !this.options.store.getOwnedConversationMetadata(cursor, caller.tenantId!, caller.userId ?? caller.callerId)) throw new HttpProblem(422, "invalid_cursor", "cursor does not identify a conversation");
    const result = this.options.store.listConversations(limit, cursor, caller.tenantId, caller.userId ?? caller.callerId);
    this.writeJson(response, 200, { data: result.items, page: { next_cursor: result.nextCursor, has_more: result.hasMore } });
  }

  private async createConversation(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const title = body.title === undefined || body.title === null ? null : this.stringField(body.title, "title", 200);
    const kind = body.kind === undefined ? "chat" : this.stringField(body.kind, "kind", 64);
    const labels = body.labels === undefined ? [] : this.stringArray(body.labels, "labels", 32);
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : randomUUID();
    if (this.options.store.getConversationMetadata(id)) throw new HttpProblem(409, "conversation_exists", "Conversation already exists");
    let schedule = null;
    if (body.schedule !== undefined && body.schedule !== null) schedule = this.parseSchedule(body.schedule);
    const metadata = this.options.store.createConversation({
      id, title, kind, labels, state: "active", schedule,
      entryEmployeeId: this.optionalString(body.entry_employee_id, "entry_employee_id"),
      coordinatorEmployeeId: this.optionalString(body.coordinator_employee_id, "coordinator_employee_id"),
      solutionRef: this.optionalString(body.solution_instance_id, "solution_instance_id"),
      tenantId: caller.tenantId,
      memberId: caller.userId ?? caller.callerId,
    });
    this.writeJson(response, 201, { data: metadata });
  }

  private requireOwnedConversation(conversationId: string, caller: AuthenticatedCaller): void {
    if (!caller.tenantId) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant is required");
    if (!this.options.store.getOwnedConversation(conversationId, caller.tenantId, caller.userId ?? caller.callerId)) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
  }

  private getConversationId(pathname: string): string {
    const match = pathname.match(/^\/api\/agent\/conversations\/([^/]+)/);
    if (!match) throw new HttpProblem(404, "not_found", "Conversation not found");
    return decodeURIComponent(match[1]);
  }

  private getConversation(response: ServerResponse, pathname: string, caller: AuthenticatedCaller): void {
    const metadata = this.options.store.getOwnedConversationMetadata(this.getConversationId(pathname), caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: metadata });
  }

  private async updateConversation(request: IncomingMessage, response: ServerResponse, pathname: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const patch: Parameters<AgentSqliteStore["updateConversation"]>[1] = {};
    if (body.title !== undefined) patch.title = body.title === null ? null : this.stringField(body.title, "title", 200);
    if (body.kind !== undefined) patch.kind = this.stringField(body.kind, "kind", 64);
    if (body.labels !== undefined) patch.labels = this.stringArray(body.labels, "labels", 32);
    if (body.schedule !== undefined) patch.schedule = body.schedule === null ? null : this.parseSchedule(body.schedule);
    if (body.last_read_entry_id !== undefined) patch.lastReadEntryId = this.optionalString(body.last_read_entry_id, "last_read_entry_id");
    this.requireOwnedConversation(this.getConversationId(pathname), caller);
    const updated = this.options.store.updateConversation(this.getConversationId(pathname), patch);
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private getConversationState(response: ServerResponse, pathname: string, caller: AuthenticatedCaller): void {
    const metadata = this.options.store.getOwnedConversationMetadata(this.getConversationId(pathname), caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { conversation_id: metadata.id, state: metadata.state } });
  }

  private async updateConversationState(request: IncomingMessage, response: ServerResponse, pathname: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const state = this.stringField(body.state, "state", 32) as ConversationState;
    if (!["draft", "active", "paused", "muted", "archived"].includes(state)) throw new HttpProblem(422, "invalid_state", "Unsupported conversation state");
    this.requireOwnedConversation(this.getConversationId(pathname), caller);
    const updated = this.options.store.updateConversation(this.getConversationId(pathname), { state });
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private async deleteConversation(response: ServerResponse, pathname: string, caller: AuthenticatedCaller): Promise<void> {
    if (!(await this.options.host.delete(this.getConversationId(pathname), caller.tenantId!, caller.userId ?? caller.callerId))) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { deleted: true } });
  }

  private listExperts(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listSolutions(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSolutions(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listMarketplaceTemplates(response: ServerResponse): void { this.writeJson(response, 200, { data: [], page: { next_cursor: null, has_more: false } }); }
  private listKnowledgeBases(response: ServerResponse): void { this.writeJson(response, 200, { data: [], page: { next_cursor: null, has_more: false } }); }
  private listKnowledgeReadModel(response: ServerResponse): void { this.writeJson(response, 200, { data: [], page: { next_cursor: null, has_more: false } }); }
  private listSnapshots(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSnapshots(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listOutbox(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listUsageOutbox(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }

  private async flushUsage(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.usageFlush) throw new HttpProblem(503, "manager_unavailable", "Manager usage upload is not configured");
    const body = await this.readJson(request);
    const limit = body.limit === undefined ? 50 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(422, "invalid_limit", "limit must be an integer between 1 and 100");
    const result = await this.options.usageFlush.flush(caller, limit);
    this.writeJson(response, 200, { data: result });
  }

  private async syncGrants(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.managerClient) throw new HttpProblem(503, "manager_unavailable", "Manager sync is not configured");
    const body = await this.readJson(request);
    const tenantId = this.stringField(body.tenant_id, "tenant_id", 200);
    const memberId = this.stringField(body.member_id, "member_id", 200);
    if (tenantId !== caller.tenantId || memberId !== (caller.userId ?? caller.callerId)) throw new HttpProblem(403, "forbidden", "Sync identity does not match authenticated caller");
    const knownVersions = body.known_versions === undefined ? {} : this.objectField(body.known_versions, "known_versions");
    try {
      const config = normalizeAuthorizedConfig(await this.options.managerClient.pullAuthorizedConfig(caller, knownVersions as Record<string, string>), caller.tenantId, caller.userId ?? caller.callerId);
      const snapshots = config.snapshots ?? (this.options.managerClient.pullSnapshots ? await this.options.managerClient.pullSnapshots(caller, config.experts ?? []) : []);
      const memberId = caller.userId ?? caller.callerId;
      const skillPackagesAuthoritative = config.skill_packages !== undefined;
      const signedPackages = config.skill_packages ?? [];
      const publicKey = process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
      const keyId = process.env.AITEAM_SKILL_SIGNING_KEY_ID;
      // Verify every envelope before changing projections or cache. Missing key means
      // package sync is disabled, not an invitation to accept unsigned content.
      if (signedPackages.length && (!publicKey || !keyId)) throw new HttpProblem(503, "skill_signing_unconfigured", "Signed skill verification is not configured");
      if (signedPackages.length) {
        try {
          for (const envelope of signedPackages) {
            verifySignedSkillPackage(envelope, { publicKey, keyId, tenantId: caller.tenantId, memberId });
          }
        } catch (error) {
          if (error instanceof SkillVerificationError) throw new HttpProblem(503, "skill_package_invalid", "Manager returned an invalid signed skill package");
          throw error;
        }
      }
      let bundleArtifacts = [] as KnowledgeArtifact[];
      let bundleAuthoritative = false;
      if (this.options.managerClient.pullKnowledgeArtifacts) {
        const bundle = await this.options.managerClient.pullKnowledgeArtifacts(caller, {});
        if (typeof bundle.authoritative !== "boolean" || !Array.isArray(bundle.artifacts)) throw new ManagerUnavailableError("Manager returned an invalid knowledge bundle");
        bundleArtifacts = bundle.artifacts.map((artifact) => normalizeKnowledgeArtifact(artifact, caller.tenantId, memberId));
        bundleAuthoritative = bundle.authoritative;
      }
      const result = bundleAuthoritative
        ? this.options.store.replaceProjectionsAndKnowledge(config.experts ?? [], config.solutions ?? [], snapshots, config.revoked_ids ?? [], bundleArtifacts, { tenantId: caller.tenantId!, memberId })
        : { ...this.options.store.replaceProjections(config.experts ?? [], config.solutions ?? [], snapshots, config.revoked_ids ?? [], { tenantId: caller.tenantId!, memberId }), knowledge: undefined };
      const knowledge = result.knowledge;
      if (skillPackagesAuthoritative && this.options.skillCache && (signedPackages.length === 0 || (publicKey && keyId))) {
        const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
        const currentEmployeeIds = new Set(experts.filter((expert) => !expert.revoked).map((expert) => expert.employee_id));
        const refs = experts.filter((expert) => currentEmployeeIds.has(expert.employee_id)).flatMap((expert) => {
          const values = expert.skills;
          return Array.isArray(values) ? values.filter((ref): ref is string => typeof ref === "string") : [];
        });
        refs.push(...this.options.store.listSnapshots(caller.tenantId, memberId).filter((snapshot) => currentEmployeeIds.has(snapshot.employee_id)).flatMap((snapshot) => skillRefsForSnapshot(snapshot as { skill_refs?: unknown; skills?: unknown })));
        this.options.skillCache.reconcile({ tenantId: caller.tenantId, memberId }, signedPackages, refs, { publicKey, keyId });
      }
      this.writeJson(response, 200, { data: { ok: true, ...result, ...(knowledge ? { knowledge } : {}) } });
    } catch (error) {
      if (error instanceof ManagerUnavailableError || error instanceof TypeError) throw new HttpProblem(503, "manager_unavailable", "Manager sync is unavailable");
      throw error;
    }
  }

  private async readiness(response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    const runtime = (await this.options.runtimeReady?.()) ?? true;
    const state = runtime ? "ready" : "blocked";
    const experts = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).map((expert) => this.expertReadinessValue(expert, runtime));
    this.writeJson(response, 200, { data: { runtime: state, runtime_reason: runtime ? undefined : "Pi runtime is not ready", experts } });
  }

  private async expertReadiness(response: ServerResponse, pathname: string, caller: AuthenticatedCaller): Promise<void> {
    const id = decodeURIComponent(pathname.split("/").at(-2) ?? "");
    const expert = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === id);
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

  private officeScene(response: ServerResponse, caller: AuthenticatedCaller): void {
    const employees = this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).map((expert) => ({ employee_id: expert.employee_id, display_name: expert.display_name, status: expert.revoked ? "offline" : "ready", task: null, avatar_url: typeof expert.avatar_url === "string" ? expert.avatar_url : null }));
    const summary = { total: employees.length, working: 0, ready: employees.filter((employee) => employee.status === "ready").length, offline: employees.filter((employee) => employee.status === "offline").length };
    this.writeJson(response, 200, { data: { employees, summary } });
  }

  private officeFeed(response: ServerResponse): void { this.writeJson(response, 200, { data: { events: [] } }); }

  private stringField(value: unknown, name: string, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpProblem(422, `invalid_${name}`, `${name} must be a non-empty string <= ${max} characters`); return value; }
  private optionalString(value: unknown, name: string): string | null { if (value === undefined || value === null) return null; return this.stringField(value, name, 256); }
  private stringArray(value: unknown, name: string, maxItems: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 128)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an array of strings`); return value as string[]; }
  private objectField(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpProblem(422, `invalid_${name}`, `${name} must be an object`); return value as Record<string, unknown>; }
  private parseSchedule(value: unknown): Record<string, unknown> {
    try { return validateSchedule(value) as unknown as Record<string, unknown>; }
    catch (error) { throw new HttpProblem(422, "invalid_schedule", error instanceof Error ? error.message : "Unsupported schedule"); }
  }

  private async prompt(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const callerId = caller.callerId;
    const key = this.header(request, "idempotency-key");
    if (!key || key.length > 256) throw new HttpProblem(422, "invalid_idempotency_key", "Idempotency-Key is required and must be <= 256 characters");
    const conversation = this.options.store.getOwnedConversation(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!conversation) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    const payload = await this.readJson(request);
    const text = payload.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 200_000) {
      throw new HttpProblem(422, "invalid_prompt", "text must be a non-empty string <= 200000 characters");
    }
    const images = this.validateInlineImages(payload.images);
    const attachmentIds = payload.attachment_ids === undefined ? [] : this.stringArray(payload.attachment_ids, "attachment_ids", MAX_PROMPT_IMAGES);
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new HttpProblem(422, "invalid_attachment_ids", "attachment_ids must not contain duplicates");
    const mentions = payload.mentions === undefined ? [] : this.stringArray(payload.mentions, "mentions", 16);
    // Fingerprint IDs, not mutable attachment bytes, so completed/accepted retries can return their receipt.
    const fingerprint = createHash("sha256").update(JSON.stringify({ text, images, attachment_ids: attachmentIds, mentions })).digest("hex");
    const receipt = this.options.store.reservePrompt({ conversationId, callerId, key, fingerprint });
    if (!receipt.isNew) return this.writeReceipt(response, conversationId, key, receipt.state);

    try {
      const employeeId = conversation.entryEmployeeId ?? conversation.coordinatorEmployeeId;
      const expert = employeeId ? this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === employeeId && !item.revoked) : undefined;
      const snapshot = employeeId && expert ? this.options.store.listSnapshots(caller.tenantId, caller.userId ?? caller.callerId).find((item) => item.employee_id === employeeId && item.version === expert.version) : undefined;
      if (!employeeId || !expert || !snapshot) throw new HttpProblem(403, "employee_not_authorized", "Conversation requires a locally authorized employee snapshot");
      const loadedImages: ImageContent[] = [];
      let decodedImageBytes = images.reduce((total, image) => total + Buffer.byteLength(image.data, "base64"), 0);
      for (const attachmentId of attachmentIds) {
        const loaded = this.options.store.readOwnedLocalFile(attachmentId, conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
        if (!loaded) throw new HttpProblem(404, "attachment_not_found", "Attachment not found");
        if (loaded.record.kind !== "attachment" || !IMAGE_MIMES.has(loaded.record.mime_type) || !hasImageSignature(loaded.record.mime_type, loaded.data)) throw new HttpProblem(422, "invalid_attachment", "Only valid image attachments can be sent to Pi");
        decodedImageBytes += loaded.data.byteLength;
        loadedImages.push({ type: "image", data: loaded.data.toString("base64"), mimeType: loaded.record.mime_type });
      }
      if (loadedImages.length + images.length > MAX_PROMPT_IMAGES) throw new HttpProblem(422, "invalid_images", "A prompt may contain at most 8 images");
      if (decodedImageBytes > MAX_PROMPT_IMAGE_BYTES) throw new HttpProblem(413, "prompt_images_too_large", "Decoded prompt images exceed 20 MiB");
      const promptImages = [...images, ...loadedImages];
      const worker = this.runPrompt(conversationId, caller, key, receipt.ownerInstance, text, promptImages, mentions, attachmentIds);
      this.promptWorkers.add(worker);
      void worker.finally(() => this.promptWorkers.delete(worker));
      this.writeReceipt(response, conversationId, key, "accepted");
    } catch (error) {
      this.options.store.markUnknown(conversationId, callerId, key, receipt.ownerInstance);
      throw error;
    }
    return;
  }

  private async runPrompt(conversationId: string, caller: AuthenticatedCaller, key: string, ownerInstance: string | undefined, text: string, images: ImageContent[], mentions: string[], attachmentIds: string[]): Promise<void> {
    const callerId = caller.callerId;
    const heartbeat = setInterval(() => this.options.store.renewLease(conversationId, callerId, key, ownerInstance), 10_000);
    try {
      const lastEntryId = await this.options.host.prompt(conversationId, text, images, caller, mentions);
      this.options.store.markLocalFilesReferenced(attachmentIds, conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
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
      if (!response.writableEnded) {
        const event = serializePiEvent(envelope.event, {
          ...(envelope.source_ref ? { conversation_id: envelope.conversation_id, source_ref: envelope.source_ref, tool_call_id: envelope.tool_call_id } : {}),
        });
        if (!event) return;
        response.write(`id: ${envelope.id}\nevent: pi\ndata: ${JSON.stringify(event)}\n\n`);
      }
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
    if (pathname === "/api/agent/usage/flush") return "usage-flush";
    if (pathname === "/api/agent/marketplace/templates" || /^\/api\/agent\/marketplace\/templates\/[^/]+$/.test(pathname)) return "marketplace";
    if (pathname === "/api/agent/knowledge-bases") return "knowledge-bases";
    if (/^\/api\/agent\/knowledge-bases\/[^/]+\/(search|documents|ingestions)(\/[^/]+)?$/.test(pathname)) return "knowledge-read";
    if (pathname === "/api/agent/org/tree") return "org";
    if (pathname === "/api/agent/office/scene") return "office-scene";
    if (pathname === "/api/agent/office/feed") return "office-feed";
    if (/^\/api\/agent\/conversations\/[^/]+\/(group-dispatch|terminal\/execute)$/.test(pathname) || pathname.startsWith("/api/agent/recruitments") || pathname.startsWith("/api/agent/knowledge-bases/")) return "gone";
    return undefined;
  }

  private matchConversationRoute(pathname: string): { conversationId: string; action: "prompt" | "events" | "abort" | "entries" | "files" | "file"; kind?: LocalFileKind; fileId?: string } | undefined {
    const match = pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/(prompt|events|abort|entries)$/);
    if (match) return { conversationId: decodeURIComponent(match[1]), action: match[2] as "prompt" | "events" | "abort" | "entries" };
    const files = pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/(attachments|artifacts)(?:\/([^/]+))?$/);
    if (!files) return undefined;
    return { conversationId: decodeURIComponent(files[1]), action: files[3] ? "file" : "files", kind: files[2] === "artifacts" ? "artifact" : "attachment", ...(files[3] ? { fileId: decodeURIComponent(files[3]) } : {}) };
  }

  private listLocalFiles(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind }, caller: AuthenticatedCaller): void {
    this.requireOwnedConversation(route.conversationId, caller);
    const items = this.options.store.listOwnedLocalFiles(route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId, route.kind);
    this.writeJson(response, 200, { data: items, page: { next_cursor: null, has_more: false } });
  }

  private async uploadLocalFile(request: IncomingMessage, response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind }, caller: AuthenticatedCaller): Promise<void> {
    this.requireOwnedConversation(route.conversationId, caller);
    const body = await this.readJson(request, MAX_UPLOAD_JSON_BYTES);
    const filename = this.stringField(body.filename, "filename", MAX_LOCAL_FILE_NAME);
    if (filename.includes("/") || filename.includes("\\") || /[\x00-\x1f\x7f]/u.test(filename)) throw new HttpProblem(422, "invalid_filename", "filename must be a safe basename");
    const mimeType = body.mime_type ?? body.mimeType;
    if (typeof mimeType !== "string" || !ALLOWED_FILE_MIMES.has(mimeType)) throw new HttpProblem(422, "invalid_mime_type", "Unsupported MIME type");
    const encoded = this.stringField(body.data, "data", Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4);
    const data = decodeBase64(encoded);
    if (!data) throw new HttpProblem(422, "invalid_file_data", "data must be canonical base64");
    if (data.byteLength > MAX_LOCAL_FILE_BYTES) throw new HttpProblem(413, "file_too_large", "Decoded file exceeds 5 MiB");
    if (mimeType.startsWith("image/") && (!IMAGE_MIMES.has(mimeType) || !hasImageSignature(mimeType, data))) throw new HttpProblem(422, "invalid_image_content", "Image MIME type does not match its content");
    try {
      const record = this.options.store.createLocalFile({ conversationId: route.conversationId, tenantId: caller.tenantId!, memberId: caller.userId ?? caller.callerId, kind: route.kind ?? "attachment", filename, mimeType, data });
      this.writeJson(response, 201, { data: record });
    } catch (error) {
      if (error instanceof Error && error.message.includes("maximum size")) throw new HttpProblem(413, "file_too_large", error.message);
      if (error instanceof Error && (error.message.includes("Local file count limit") || error.message.includes("Local file storage limit"))) throw new HttpProblem(413, "local_file_storage_limit", error.message);
      throw error;
    }
  }

  private downloadLocalFile(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind; fileId?: string }, caller: AuthenticatedCaller): void {
    if (!route.fileId) throw new HttpProblem(404, "file_not_found", "File not found");
    const loaded = this.options.store.readOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!loaded || loaded.record.kind !== route.kind) throw new HttpProblem(404, "file_not_found", "File not found");
    this.writeBytes(response, 200, loaded.data, loaded.record.mime_type, loaded.record.filename);
  }

  private deleteLocalFile(response: ServerResponse, route: { conversationId: string; kind?: LocalFileKind; fileId?: string }, caller: AuthenticatedCaller): void {
    const existing = route.fileId ? this.options.store.getOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId) : undefined;
    if (!route.fileId || !existing || existing.kind !== route.kind || !this.options.store.deleteOwnedLocalFile(route.fileId, route.conversationId, caller.tenantId!, caller.userId ?? caller.callerId)) throw new HttpProblem(404, "file_not_found", "File not found");
    this.writeJson(response, 200, { data: { deleted: true, id: route.fileId } });
  }


  private async readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new HttpProblem(413, "request_too_large", "Request body is too large");
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

  private validateInlineImages(value: unknown): ImageContent[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES) throw new HttpProblem(422, "invalid_images", "images must contain at most 8 image objects");
    return value.map((image) => {
      if (!image || typeof image !== "object") throw new HttpProblem(422, "invalid_images", "Invalid image object");
      const candidate = image as Record<string, unknown>;
      if (candidate.type !== "image" || typeof candidate.data !== "string" || typeof candidate.mimeType !== "string" || !IMAGE_MIMES.has(candidate.mimeType)) throw new HttpProblem(422, "invalid_images", "Unsupported image attachment");
      const bytes = decodeBase64(candidate.data);
      if (!bytes) throw new HttpProblem(422, "invalid_images", "Image data must be canonical base64");
      if (bytes.byteLength > MAX_LOCAL_FILE_BYTES) throw new HttpProblem(413, "image_too_large", "Decoded image exceeds 5 MiB");
      if (!hasImageSignature(candidate.mimeType, bytes)) throw new HttpProblem(422, "invalid_image_content", "Image MIME type does not match its content");
      return { type: "image", data: bytes.toString("base64"), mimeType: candidate.mimeType } as ImageContent;
    });
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

  private writeMetrics(response: ServerResponse): void {
    const body = [
      "# TYPE aiteam_agent_http_requests_total counter",
      `aiteam_agent_http_requests_total ${this.requests}`,
      "# TYPE aiteam_agent_http_errors_total counter",
      `aiteam_agent_http_errors_total ${this.errors}`,
      "",
    ].join("\n");
    this.writeText(response, 200, body, "text/plain; version=0.0.4; charset=utf-8");
  }

  private writeText(response: ServerResponse, status: number, body: string, contentType: string): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "Content-Length": Buffer.byteLength(body), "Content-Type": contentType });
    response.end(body);
  }

  private writeBytes(response: ServerResponse, status: number, body: Buffer, contentType: string, filename: string): void {
    if (response.writableEnded) return;
    response.writeHead(status, { "Content-Length": body.byteLength, "Content-Type": contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` });
    response.end(body);
  }

  private serveSpa(pathname: string, response: ServerResponse): boolean {
    const root = this.options.spaRoot;
    if (!root || pathname.startsWith("/api/") || pathname === "/api") return false;
    const candidate = pathname === "/" ? "index.html" : pathname.slice(1);
    const requested = resolve(root, candidate);
    const rootResolved = resolve(root);
    const rel = relative(rootResolved, requested);
    let file = requested;
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    try { if (!statSync(file).isFile()) file = join(rootResolved, "index.html"); } catch { file = join(rootResolved, "index.html"); }
    try {
      const content = readFileSync(file);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" }[extname(file)] ?? "application/octet-stream";
      response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); response.end(content); return true;
    } catch { return false; }
  }

  private writeError(response: ServerResponse, error: unknown, requestId: string): void {
    if (response.writableEnded) return;
    let problem: { status: number; code: string; detail: string; errors?: unknown };
    if (error instanceof HttpProblem) problem = { status: error.status, code: error.code, detail: error.message, errors: error.errors };
    else if (error instanceof IdempotencyConflictError) problem = { status: 409, code: "idempotency_conflict", detail: error.message };
    else if (error instanceof IdempotencyUnknownError) problem = { status: 409, code: "idempotency_unknown", detail: error.message };
    else if (error instanceof ConversationBusyError) problem = { status: 409, code: "conversation_busy", detail: error.message };
    else if (error instanceof EventCursorStaleError) problem = { status: 409, code: "stale_cursor", detail: error.message };
    else if (error instanceof InvalidEventCursorError) problem = { status: 422, code: "invalid_cursor", detail: error.message };
    else if (error instanceof SessionAuthorizationError) problem = { status: 403, code: "employee_not_authorized", detail: error.message };
    else problem = { status: 500, code: "internal_error", detail: "Internal server error" };
    this.writeJson(response, problem.status, { type: "about:blank", title: problem.code, status: problem.status, code: problem.code, detail: problem.detail, instance: requestId, request_id: requestId, ...(problem.errors ? { errors: problem.errors } : {}) }, "application/problem+json; charset=utf-8");
  }
}

function decodeBase64(value: string): Buffer | undefined {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function hasImageSignature(mimeType: string, data: Buffer): boolean {
  if (mimeType === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mimeType === "image/gif") return data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a");
  if (mimeType === "image/webp") return data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

const LOCAL_FILE_DOWNLOAD_CONTENT = Object.fromEntries([...ALLOWED_FILE_MIMES].map((mime) => [mime, {}]));

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "AI Team Agent Service", version: "0.1.0" },
  paths: {
    "/healthz": { get: { operationId: "healthz", responses: { "200": { description: "Alive" } } } },
    "/readyz": { get: { operationId: "readyz", responses: { "200": { description: "Ready" }, "503": { description: "Not ready" } } } },
    "/api/agent/conversations/{conversation_id}/prompt": { post: { operationId: "promptConversation", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 256 } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PromptRequest" } } } }, responses: { "202": { description: "Accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/PromptAcceptedEnvelope" } } } }, "409": { description: "Conflict" }, "422": { description: "Validation error" } } } },
    "/api/agent/conversations/{conversation_id}/events": { get: { operationId: "subscribeConversationEvents", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "after", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "Pi event stream" } } } },
    "/api/agent/conversations/{conversation_id}/abort": { post: { operationId: "abortConversation", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Abort result" }, "404": { description: "Not found" } } } },
    "/api/agent/conversations/{conversation_id}/entries": { get: { operationId: "listConversationEntries", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Pi entries" } } } },
    "/api/agent/conversations": { get: { operationId: "listConversations", responses: { "200": { description: "Conversation metadata" } } }, post: { operationId: "createConversation", responses: { "201": { description: "Conversation metadata" } } } },
    "/api/agent/conversations/{conversation_id}": { parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], get: { operationId: "getConversation", responses: { "200": { description: "Conversation metadata" } } }, patch: { operationId: "updateConversation", responses: { "200": { description: "Conversation metadata" } } }, delete: { operationId: "deleteConversation", responses: { "200": { description: "Deleted" } } } },
    "/api/agent/conversations/{conversation_id}/state": { put: { operationId: "setConversationState", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Conversation metadata" } } } },
    "/api/agent/conversations/{conversation_id}/attachments": {
      get: { operationId: "listAttachments", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Local attachment metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileListEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
      post: { operationId: "uploadAttachment", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileUpload" } } } }, responses: { "201": { description: "Stored local attachment metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" }, "413": { $ref: "#/components/responses/TooLarge" }, "422": { $ref: "#/components/responses/ValidationError" } } },
    },
    "/api/agent/conversations/{conversation_id}/attachments/{attachment_id}": {
      get: { operationId: "downloadAttachment", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "attachment_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Local attachment bytes", content: LOCAL_FILE_DOWNLOAD_CONTENT }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
      delete: { operationId: "deleteAttachment", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "attachment_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileDeleteEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/api/agent/conversations/{conversation_id}/artifacts": {
      get: { operationId: "listArtifacts", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Local artifact metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileListEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
      post: { operationId: "uploadArtifact", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileUpload" } } } }, responses: { "201": { description: "Stored local artifact metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" }, "413": { $ref: "#/components/responses/TooLarge" }, "422": { $ref: "#/components/responses/ValidationError" } } },
    },
    "/api/agent/conversations/{conversation_id}/artifacts/{artifact_id}": {
      get: { operationId: "downloadArtifact", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "artifact_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Local artifact bytes", content: LOCAL_FILE_DOWNLOAD_CONTENT }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
      delete: { operationId: "deleteArtifact", parameters: [{ name: "conversation_id", in: "path", required: true, schema: { type: "string" } }, { name: "artifact_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/LocalFileDeleteEnvelope" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "404": { $ref: "#/components/responses/NotFound" } } },
    },
    "/api/auth/resolve-tenant-by-account": { post: { operationId: "resolveTenantByAccount", responses: { "200": { description: "Resolved tenant" }, "503": { description: "Manager unavailable" } } } },
    "/api/agent/login": { post: { operationId: "login", responses: { "200": { description: "Manager-issued token" }, "401": { description: "Authentication failed" } } } },
    "/api/agent/reset-password": { post: { operationId: "resetPassword", responses: { "200": { description: "Manager-issued token" }, "401": { description: "Reset failed" } } } },
    "/api/agent/ping": { get: { operationId: "ping", responses: { "200": { description: "Pong" } } } },
    "/api/agent/whoami": { get: { operationId: "whoami", responses: { "200": { description: "Authenticated caller" } } } },
    "/api/agent/grants/experts": { get: { operationId: "listAuthorizedExperts", responses: { "200": { description: "Local projection" } } } },
    "/api/agent/grants/solutions": { get: { operationId: "listAuthorizedSolutions", responses: { "200": { description: "Local projection" } } } },
    "/api/agent/grants/snapshots": { get: { operationId: "listFrozenSnapshots", responses: { "200": { description: "Frozen snapshots" } } } },
    "/api/agent/grants/readiness": { get: { operationId: "grantsReadiness", responses: { "200": { description: "Readiness" } } } },
    "/api/agent/grants/experts/{employee_id}/readiness": { get: { operationId: "expertReadiness", parameters: [{ name: "employee_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Readiness" } } } },
    "/api/agent/grants/sync": { post: { operationId: "syncGrants", responses: { "200": { description: "Sync result" }, "503": { description: "Manager unavailable" } } } },
    "/api/agent/usage/outbox": { get: { operationId: "listUsageOutbox", responses: { "200": { description: "Usage summaries" } } } },
    "/api/agent/usage/flush": { post: { operationId: "flushUsage", responses: { "200": { description: "Usage flush result" }, "503": { description: "Manager unavailable" } } } },
    "/api/agent/marketplace/templates": { get: { operationId: "listMarketplaceTemplates", responses: { "200": { description: "Read-only catalog projection" } } } },
    "/api/agent/knowledge-bases": { get: { operationId: "listKnowledgeBases", responses: { "200": { description: "Read-only knowledge projection" } } } },
    "/api/agent/org/tree":  { get: { operationId: "orgTree", responses: { "200": { description: "Organization tree" } } } },
    "/api/agent/office/scene": { get: { operationId: "officeScene", responses: { "200": { description: "Office scene" } } } },
    "/api/agent/office/feed": { get: { operationId: "officeFeed", responses: { "200": { description: "Office feed" } } } },
  },
  components: {
    schemas: {
      PromptRequest: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 200000 }, images: { type: "array", maxItems: 8, items: { type: "object", required: ["type", "data", "mimeType"], properties: { type: { const: "image" }, data: { type: "string", contentEncoding: "base64" }, mimeType: { type: "string", enum: ["image/gif", "image/jpeg", "image/png", "image/webp"] } } } }, attachment_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" } }, mentions: { type: "array", maxItems: 16, items: { type: "string" } } } },
      PromptAccepted: { type: "object", required: ["conversation_id", "accepted", "state", "idempotency_key"], properties: { conversation_id: { type: "string" }, accepted: { type: "boolean" }, state: { type: "string", enum: ["accepted", "completed"] }, idempotency_key: { type: "string" } } },
      PromptAcceptedEnvelope: { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/PromptAccepted" } } },
      LocalFileUpload: { type: "object", required: ["filename", "mime_type", "data"], properties: { filename: { type: "string", maxLength: 255 }, mime_type: { type: "string" }, data: { type: "string", contentEncoding: "base64" } } },
      LocalFileMetadata: { type: "object", required: ["id", "conversation_id", "tenant_id", "member_id", "kind", "filename", "mime_type", "byte_size", "sha256", "created_at", "referenced_at"], properties: { id: { type: "string" }, conversation_id: { type: "string" }, tenant_id: { type: "string" }, member_id: { type: "string" }, kind: { type: "string", enum: ["attachment", "artifact"] }, filename: { type: "string" }, mime_type: { type: "string" }, byte_size: { type: "integer", minimum: 0 }, sha256: { type: "string" }, created_at: { type: "string", format: "date-time" }, referenced_at: { type: ["string", "null"], format: "date-time" } } },
      LocalFileEnvelope: { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/LocalFileMetadata" } } },
      LocalFileListEnvelope: { type: "object", required: ["data", "page"], properties: { data: { type: "array", items: { $ref: "#/components/schemas/LocalFileMetadata" } }, page: { type: "object", properties: { next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } } } } },
      LocalFileDeleteEnvelope: { type: "object", required: ["data"], properties: { data: { type: "object", required: ["deleted", "id"], properties: { deleted: { type: "boolean" }, id: { type: "string" } } } } },
      Problem: { type: "object", required: ["type", "title", "status", "code", "detail", "instance", "request_id"], properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, code: { type: "string" }, detail: { type: "string" }, instance: { type: "string" }, request_id: { type: "string" } } },
    },
    responses: {
      Unauthorized: { description: "Authentication required", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      NotFound: { description: "Conversation or file not found", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      TooLarge: { description: "File or request exceeds a limit", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      ValidationError: { description: "Validation error", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
    },
  },
};

function swaggerHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><div id="app"></div><script>SwaggerUIBundle({url:${JSON.stringify(url)},dom_id:'#app'})</script>`;
}
function redocHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><redoc spec-url=${JSON.stringify(url)}></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>`;
}
