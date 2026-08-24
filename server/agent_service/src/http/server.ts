import { createHash, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type } from "typebox";
import { ConversationBusyError, EventCursorStaleError, InvalidEventCursorError, type PiEventEnvelope, SessionHost } from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IdempotencyConflictError, IdempotencyUnknownError, type AgentSqliteStore } from "../storage/sqlite.js";
import type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";
import { ManagerAuthError, ManagerAuthorizationError, ManagerUnavailableError, normalizeAuthorizedConfig, type ManagerClient, type MarketplaceTemplate } from "../manager-client.js";
import { SessionAuthorizationError } from "../pi/session-host.js";
import { serializePiEvent } from "../pi/event-sse.js";
import type { ConversationState, LoadedExpertProjection, LocalFileKind } from "../storage/sqlite.js";
import { validateSchedule } from "../schedule.js";
import type { UsageFlushService } from "../usage-flush.js";
import { SkillCache, SkillVerificationError, skillRefsForSnapshot, skillSigningVerificationFromEnv, verifySignedSkillPackage } from "../skills.js";
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
const require = createRequire(import.meta.url);
const REDOC_BUNDLE = readFileSync(require.resolve("redoc/bundles/redoc.standalone.js"), "utf8");
const FASTIFY_BODY = Symbol("fastifyBody");

type BufferedRequest = IncomingMessage & { [FASTIFY_BODY]?: unknown };
type AgentRouteHandler = (request: IncomingMessage, response: ServerResponse, caller?: AuthenticatedCaller, fastifyRequest?: FastifyRequest) => void | Promise<void>;

const ConversationParams = Type.Object({ conversation_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ConversationFileParams = Type.Object({ conversation_id: Type.String({ minLength: 1 }), attachment_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ConversationArtifactParams = Type.Object({ conversation_id: Type.String({ minLength: 1 }), artifact_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ExpertParams = Type.Object({ employee_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ConversationQuery = Type.Object({ after: Type.Optional(Type.String()), limit: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }, { additionalProperties: false });
const PromptImage = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({ contentEncoding: "base64" }),
  mimeType: Type.String({ enum: ["image/gif", "image/jpeg", "image/png", "image/webp"] }),
}, { additionalProperties: false });
const PromptRequest = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 200_000 }),
  images: Type.Optional(Type.Array(PromptImage, { maxItems: MAX_PROMPT_IMAGES })),
  attachment_ids: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_PROMPT_IMAGES, uniqueItems: true })),
  mentions: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
}, { $id: "PromptRequest", additionalProperties: false });
const PromptAccepted = Type.Object({ conversation_id: Type.String(), accepted: Type.Boolean(), state: Type.String({ enum: ["accepted", "completed"] }), idempotency_key: Type.String() }, { $id: "PromptAccepted" });
const PromptAcceptedEnvelope = Type.Object({ data: Type.Ref("PromptAccepted") }, { $id: "PromptAcceptedEnvelope" });
const LocalFileUpload = Type.Object({ filename: Type.String({ maxLength: MAX_LOCAL_FILE_NAME }), mime_type: Type.String(), data: Type.String({ contentEncoding: "base64" }) }, { $id: "LocalFileUpload", additionalProperties: false });
const LocalFileMetadata = Type.Object({
  id: Type.String(), conversation_id: Type.String(), tenant_id: Type.String(), member_id: Type.String(), kind: Type.String({ enum: ["attachment", "artifact"] }), filename: Type.String(), mime_type: Type.String(), byte_size: Type.Integer({ minimum: 0 }), sha256: Type.String(), created_at: Type.String({ format: "date-time" }), referenced_at: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
}, { $id: "LocalFileMetadata" });
const LocalFileEnvelope = Type.Object({ data: Type.Ref("LocalFileMetadata") }, { $id: "LocalFileEnvelope" });
const Page = Type.Object({ next_cursor: Type.Union([Type.String(), Type.Null()]), has_more: Type.Boolean() }, { $id: "Page" });
const LocalFileListEnvelope = Type.Object({ data: Type.Array(Type.Ref("LocalFileMetadata")), page: Type.Ref("Page") }, { $id: "LocalFileListEnvelope" });
const LocalFileDeleteEnvelope = Type.Object({ data: Type.Object({ deleted: Type.Boolean(), id: Type.String() }) }, { $id: "LocalFileDeleteEnvelope" });
const MarketplaceTemplate = Type.Object({ template_id: Type.String(), display_name: Type.String(), category: Type.String(), model_name: Type.String(), skills_count: Type.Integer({ minimum: 0 }), recruit_count: Type.Integer({ minimum: 0 }), is_recruited: Type.Boolean(), tags: Type.Array(Type.String()), avatar_url: Type.Union([Type.String(), Type.Null()]) }, { $id: "MarketplaceTemplate" });
const MarketplaceTemplateEnvelope = Type.Object({ data: Type.Ref("MarketplaceTemplate") }, { $id: "MarketplaceTemplateEnvelope" });
const MarketplaceTemplateListEnvelope = Type.Object({ data: Type.Array(Type.Ref("MarketplaceTemplate")), page: Type.Ref("Page") }, { $id: "MarketplaceTemplateListEnvelope" });
const UsageSummary = Type.Object({ schema_version: Type.Literal("1"), summary_id: Type.String(), tenant_id: Type.String(), member_id: Type.String(), employee_id: Type.String(), window_start: Type.String({ format: "date-time" }), window_end: Type.String({ format: "date-time" }), prompt_count: Type.Integer({ minimum: 0 }), settled_count: Type.Integer({ minimum: 0 }), error_count: Type.Integer({ minimum: 0 }), input_tokens: Type.Integer({ minimum: 0 }), output_tokens: Type.Integer({ minimum: 0 }), cache_tokens: Type.Integer({ minimum: 0 }), cost_minor: Type.Integer({ minimum: 0 }), currency: Type.Literal("USD"), duration_ms_total: Type.Integer({ minimum: 0 }) }, { $id: "UsageSummary" });
const UsageOutboxItem = Type.Object({ summary_id: Type.String(), tenant_id: Type.String(), member_id: Type.String(), kind: Type.String(), status: Type.String(), attempts: Type.Integer({ minimum: 0 }), last_error: Type.Union([Type.String(), Type.Null()]), created_at: Type.String({ format: "date-time" }), payload: Type.Optional(Type.Ref("UsageSummary")) }, { $id: "UsageOutboxItem" });
const UsageOutboxListEnvelope = Type.Object({ data: Type.Array(Type.Ref("UsageOutboxItem")), page: Type.Ref("Page") }, { $id: "UsageOutboxListEnvelope" });
const ProblemSchema = Type.Object({ type: Type.String(), title: Type.String(), status: Type.Integer(), code: Type.String(), detail: Type.String(), instance: Type.String(), request_id: Type.String(), errors: Type.Optional(Type.Any()) }, { $id: "Problem" });
const LOCAL_FILE_DOWNLOAD_CONTENT = Object.fromEntries([...ALLOWED_FILE_MIMES].map((mime) => [mime, { schema: Type.Any() }]));
const OPENAPI_SCHEMAS = [PromptRequest, PromptAccepted, PromptAcceptedEnvelope, LocalFileUpload, LocalFileMetadata, LocalFileEnvelope, Page, LocalFileListEnvelope, LocalFileDeleteEnvelope, MarketplaceTemplate, MarketplaceTemplateEnvelope, MarketplaceTemplateListEnvelope, UsageSummary, UsageOutboxItem, UsageOutboxListEnvelope, ProblemSchema] as const;

function routeSchema(operationId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId, ...fields };
}

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
  private readonly app: FastifyInstance;
  private requests = 0;
  private errors = 0;
  private readonly promptWorkers = new Set<Promise<void>>();

  constructor(private readonly options: AgentHttpServerOptions) {
    this.app = Fastify({
      bodyLimit: MAX_UPLOAD_JSON_BYTES,
      requestIdHeader: "x-request-id",
      genReqId: () => randomUUID(),
      logger: false,
    });
    // Business handlers retain the existing trust-boundary validation. Fastify
    // schemas are the single OpenAPI source, without changing their legacy
    // error/status semantics through a second validator/serializer.
    this.app.setValidatorCompiler(() => () => true);
    this.app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    this.server = this.app.server;
    this.app.addHook("onRequest", async (request, reply) => {
      this.requests += 1;
      reply.raw.setHeader("X-Request-ID", request.id);
    });
    this.app.setErrorHandler((error, request, reply) => {
      this.errors += 1;
      if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
      reply.hijack();
      this.writeError(reply.raw, this.fastifyError(error), String(request.id));
    });
    this.app.setNotFoundHandler((request, reply) => {
      reply.hijack();
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (request.method === "GET" && this.serveSpa(pathname, reply.raw)) return;
      this.errors += 1;
      this.writeError(reply.raw, new HttpProblem(404, "not_found", "Route not found"), String(request.id));
    });
    void this.app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "AI Team Agent Service", version: "0.1.0" },
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
          responses: {
            Unauthorized: { description: "Authentication required", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
            NotFound: { description: "Conversation or file not found", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
            TooLarge: { description: "File or request exceeds a limit", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
            ValidationError: { description: "Validation error", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
            ManagerUnavailable: { description: "Manager-backed capability is unavailable", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
          },
        },
      },
      refResolver: { buildLocalReference: (json: any, _baseUri: any, _fragment: string, index: number) => json.$id ?? `def-${index}` },
      transformObject: (documentObject: any) => {
        const openapiObject = documentObject.openapiObject ?? documentObject.swaggerObject;
        const responseNames = new Set(["Unauthorized", "NotFound", "TooLarge", "ValidationError", "ManagerUnavailable"]);
        for (const pathItem of Object.values(openapiObject.paths ?? {})) {
          for (const operation of Object.values(pathItem as Record<string, any>)) {
            if (!operation || typeof operation !== "object" || !operation.responses) continue;
            for (const [status, response] of Object.entries(operation.responses as Record<string, any>)) {
              if (response && responseNames.has(response.description)) operation.responses[status] = { $ref: `#/components/responses/${response.description}` };
            }
          }
        }
        return openapiObject;
      },
    });
    this.app.after(() => {
      for (const schema of OPENAPI_SCHEMAS) this.app.addSchema(schema);
      this.registerRoutes();
      // Do not emit `upgrade-insecure-requests`: taiyi/dev serves HTTP directly;
      // TLS termination can add that policy at the edge without breaking local docs.
      this.app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { url: "/openapi.json", docExpansion: "list" } });
    });
  }

  async listen(port: number, host = "127.0.0.1"): Promise<void> {
    await this.app.listen({ port, host });
  }

  async close(): Promise<void> {
    await this.options.host.abortAll();
    await Promise.allSettled([...this.promptWorkers]);
    await this.app.close();
  }

  private registerRoutes(): void {
    const generic = Type.Object({ data: Type.Any() });
    const jsonResponse = (schema: unknown, description = "Successful response") => ({ description, content: { "application/json": { schema } } });
    const problemResponse = (name: "Unauthorized" | "NotFound" | "TooLarge" | "ValidationError" | "ManagerUnavailable") => ({ description: name, content: { "application/problem+json": { schema: Type.Ref("Problem") } } });
    this.registerRoute("GET", "/healthz", (_request, response) => this.writeJson(response, 200, { data: { status: "ok" } }), routeSchema("healthz", { response: { 200: generic } }), false);
    this.registerRoute("GET", "/metrics", (_request, response) => this.writeMetrics(response), routeSchema("metrics", { response: { 200: { description: "Prometheus metrics", content: { "text/plain": { schema: Type.String() } } } } }), false);
    this.registerRoute("GET", "/readyz", async (_request, response) => {
      let ready = false;
      try {
        this.options.store.db.prepare("SELECT 1").get();
        ready = (await this.options.localReady?.()) ?? true;
      } catch { ready = false; }
      this.writeJson(response, ready ? 200 : 503, { data: { ready } });
    }, routeSchema("readyz", { response: { 200: generic, 503: generic } }), false);
    this.registerRoute("GET", "/openapi.json", (_request, response) => this.writeJson(response, 200, this.app.swagger()), routeSchema("openapi"), false);
    this.registerRoute("GET", "/redoc", (_request, response) => this.writeHtml(response, redocHtml("/openapi.json")), routeSchema("redoc"), false);
    this.registerRoute("GET", "/redoc/redoc.standalone.js", (_request, response) => this.writeText(response, 200, REDOC_BUNDLE, "text/javascript; charset=utf-8"), routeSchema("redocBundle"), false);

    this.registerRoute("POST", "/api/auth/resolve-tenant-by-account", (request, response) => this.resolveTenantByAccount(request, response), routeSchema("resolveTenantByAccount", { body: Type.Object({ account: Type.String({ minLength: 1, maxLength: 256 }) }), response: { 200: generic, 400: problemResponse("ValidationError") } }), false);
    this.registerRoute("POST", "/api/agent/login", (request, response) => this.login(request, response), routeSchema("login", { body: Type.Object({ tenant_id: Type.String({ minLength: 1, maxLength: 200 }), account: Type.String({ minLength: 1, maxLength: 256 }), password: Type.String({ minLength: 1, maxLength: 512 }) }), response: { 200: generic } }), false);
    this.registerRoute("POST", "/api/agent/reset-password", (request, response) => this.resetPassword(request, response), routeSchema("resetPassword", { body: Type.Object({ tenant_id: Type.String({ minLength: 1, maxLength: 200 }), account: Type.String({ minLength: 1, maxLength: 256 }), old_password: Type.String({ minLength: 1, maxLength: 512 }), new_password: Type.String({ minLength: 1, maxLength: 512 }) }), response: { 200: generic } }), false);

    this.registerRoute("GET", "/api/agent/ping", (_request, response) => this.writeJson(response, 200, { data: { pong: true } }), routeSchema("ping", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/whoami", (_request, response, caller) => this.writeJson(response, 200, { data: caller!.claims ?? { user_id: caller!.userId ?? caller!.callerId, tenant_id: caller!.tenantId ?? null, roles: caller!.roles ?? [] } }), routeSchema("whoami", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/conversations", (request, response, caller) => this.listConversations(response, new URL(request.url ?? "/", "http://localhost").searchParams, caller!), routeSchema("listConversations", { querystring: ConversationQuery, response: { 200: generic } }));
    this.registerRoute("POST", "/api/agent/conversations", (request, response, caller) => this.createConversation(request, response, caller!), routeSchema("createConversation", { body: Type.Object({ title: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])), kind: Type.Optional(Type.String({ maxLength: 64 })), labels: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })), entry_employee_id: Type.Optional(Type.Union([Type.String(), Type.Null()])), coordinator_employee_id: Type.Optional(Type.Union([Type.String(), Type.Null()])), solution_instance_id: Type.Optional(Type.Union([Type.String(), Type.Null()])), schedule: Type.Optional(Type.Any()) }), response: { 201: generic } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id", (_request, response, caller, fastifyRequest) => this.getConversation(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("getConversation", { params: ConversationParams, response: { 200: generic, 404: problemResponse("NotFound") } }));
    const conversationUpdateSchema = routeSchema("updateConversation", { params: ConversationParams, body: Type.Object({ title: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])), kind: Type.Optional(Type.String({ maxLength: 64 })), labels: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })), schedule: Type.Optional(Type.Any()), last_read_entry_id: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), response: { 200: generic, 404: problemResponse("NotFound") } });
    this.registerRoute("PATCH", "/api/agent/conversations/:conversation_id", (request, response, caller, fastifyRequest) => this.updateConversation(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), conversationUpdateSchema);
    this.registerRoute("PUT", "/api/agent/conversations/:conversation_id", (request, response, caller, fastifyRequest) => this.updateConversation(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), { ...conversationUpdateSchema, operationId: "replaceConversation" });
    this.registerRoute("DELETE", "/api/agent/conversations/:conversation_id", (_request, response, caller, fastifyRequest) => this.deleteConversation(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("deleteConversation", { params: ConversationParams, response: { 200: generic, 404: problemResponse("NotFound") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/state", (_request, response, caller, fastifyRequest) => this.getConversationState(response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("getConversationState", { params: ConversationParams, response: { 200: generic, 404: problemResponse("NotFound") } }));
    this.registerRoute("PUT", "/api/agent/conversations/:conversation_id/state", (request, response, caller, fastifyRequest) => this.updateConversationState(request, response, (fastifyRequest?.params as { conversation_id: string }).conversation_id, caller!), routeSchema("setConversationState", { params: ConversationParams, body: Type.Object({ state: Type.String({ minLength: 1, maxLength: 32 }) }), response: { 200: generic, 404: problemResponse("NotFound") } }));

    const promptHeaders = Type.Object({ "Idempotency-Key": Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: true });
    this.registerRoute("POST", "/api/agent/conversations/:conversation_id/prompt", (request, response, caller, fastifyRequest) => this.prompt(request, response, String((fastifyRequest?.params as { conversation_id: string }).conversation_id), caller!), routeSchema("promptConversation", { params: ConversationParams, headers: promptHeaders, body: Type.Ref("PromptRequest"), response: { 202: jsonResponse(Type.Ref("PromptAcceptedEnvelope")), 409: problemResponse("ValidationError"), 422: problemResponse("ValidationError") } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/events", (request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.requireOwnedConversation(conversationId, caller!);
      return this.events(request, response, conversationId, new URL(request.url ?? "/", "http://localhost").searchParams.get("after"));
    }, routeSchema("subscribeConversationEvents", { params: ConversationParams, querystring: Type.Object({ after: Type.Optional(Type.String()) }, { additionalProperties: false }), response: { 200: { description: "Pi event stream", content: { "text/event-stream": { schema: Type.String() } } } } }));
    this.registerRoute("GET", "/api/agent/conversations/:conversation_id/entries", async (request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.requireOwnedConversation(conversationId, caller!);
      const entries = await this.options.host.entries(conversationId);
      this.writeJson(response, 200, { data: { conversation_id: conversationId, entries } });
    }, routeSchema("listConversationEntries", { params: ConversationParams, response: { 200: generic } }));
    this.registerRoute("POST", "/api/agent/conversations/:conversation_id/abort", async (_request, response, caller, fastifyRequest) => {
      const conversationId = String((fastifyRequest?.params as { conversation_id: string }).conversation_id);
      this.requireOwnedConversation(conversationId, caller!);
      const aborted = await this.options.host.abort(conversationId);
      this.writeJson(response, 200, { data: { conversation_id: conversationId, aborted } });
    }, routeSchema("abortConversation", { params: ConversationParams, response: { 200: generic, 404: problemResponse("NotFound") } }));

    const fileCollection = (kind: LocalFileKind, operationId: string, params: unknown) => {
      const route = (fastifyRequest?: FastifyRequest) => ({ conversationId: String((fastifyRequest?.params as { conversation_id?: string })?.conversation_id ?? ""), kind });
      this.registerRoute("GET", `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}`, (_request, response, caller, fastifyRequest) => this.listLocalFiles(response, route(fastifyRequest), caller!), routeSchema(operationId, { params, response: { 200: jsonResponse(Type.Ref("LocalFileListEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
      this.registerRoute("POST", `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}`, (request, response, caller, fastifyRequest) => this.uploadLocalFile(request, response, route(fastifyRequest), caller!), routeSchema(kind === "artifact" ? "uploadArtifact" : "uploadAttachment", { params, body: Type.Ref("LocalFileUpload"), response: { 201: jsonResponse(Type.Ref("LocalFileEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound"), 413: problemResponse("TooLarge"), 422: problemResponse("ValidationError") } }));
    };
    fileCollection("attachment", "listAttachments", ConversationParams);
    fileCollection("artifact", "listArtifacts", ConversationParams);
    const fileItem = (kind: LocalFileKind, idName: "attachment_id" | "artifact_id", operationPrefix: string, params: unknown) => {
      const route = (request: IncomingMessage, fastifyRequest?: FastifyRequest) => { const values = fastifyRequest?.params as Record<string, string>; return { conversationId: values.conversation_id, kind, fileId: values[idName] }; };
      const path = `/api/agent/conversations/:conversation_id/${kind === "artifact" ? "artifacts" : "attachments"}/:${idName}`;
      this.registerRoute("GET", path, (request, response, caller, fastifyRequest) => this.downloadLocalFile(response, route(request, fastifyRequest), caller!), routeSchema(`download${operationPrefix}`, { params, response: { 200: { description: "Local file bytes", content: LOCAL_FILE_DOWNLOAD_CONTENT }, 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
      this.registerRoute("DELETE", path, (request, response, caller, fastifyRequest) => this.deleteLocalFile(response, route(request, fastifyRequest), caller!), routeSchema(`delete${operationPrefix}`, { params, response: { 200: jsonResponse(Type.Ref("LocalFileDeleteEnvelope")), 401: problemResponse("Unauthorized"), 404: problemResponse("NotFound") } }));
    };
    fileItem("attachment", "attachment_id", "Attachment", ConversationFileParams);
    fileItem("artifact", "artifact_id", "Artifact", ConversationArtifactParams);

    this.registerRoute("GET", "/api/agent/grants/experts", (_request, response, caller) => this.listExperts(response, caller!), routeSchema("listAuthorizedExperts", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/grants/solutions", (_request, response, caller) => this.listSolutions(response, caller!), routeSchema("listAuthorizedSolutions", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/grants/snapshots", (_request, response, caller) => this.listSnapshots(response, caller!), routeSchema("listFrozenSnapshots", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/grants/readiness", (_request, response, caller) => this.readiness(response, caller!), routeSchema("grantsReadiness", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/grants/experts/:employee_id/readiness", (_request, response, caller, fastifyRequest) => this.expertReadiness(response, (fastifyRequest?.params as { employee_id: string }).employee_id, caller!), routeSchema("expertReadiness", { params: ExpertParams, response: { 200: generic } }));
    this.registerRoute("POST", "/api/agent/grants/sync", (request, response, caller) => this.syncGrants(request, response, caller!), routeSchema("syncGrants", { body: Type.Object({ tenant_id: Type.String({ minLength: 1, maxLength: 200 }), member_id: Type.String({ minLength: 1, maxLength: 200 }), known_versions: Type.Optional(Type.Record(Type.String(), Type.String())) }), response: { 200: generic, 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/usage/outbox", (_request, response, caller) => this.listOutbox(response, caller!), routeSchema("listUsageOutbox", { response: { 200: jsonResponse(Type.Ref("UsageOutboxListEnvelope")) } }));
    this.registerRoute("POST", "/api/agent/usage/flush", (request, response, caller) => this.flushUsage(request, response, caller!), routeSchema("flushUsage", { body: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), response: { 200: generic, 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/marketplace/templates", (_request, response, caller) => this.listMarketplaceTemplates(response, caller!), routeSchema("listMarketplaceTemplates", { response: { 200: jsonResponse(Type.Ref("MarketplaceTemplateListEnvelope")), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/marketplace/templates/:template_id", (_request, response, caller, fastifyRequest) => this.listMarketplaceTemplates(response, caller!, (fastifyRequest?.params as { template_id: string }).template_id), routeSchema("getMarketplaceTemplate", { params: Type.Object({ template_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }), response: { 200: jsonResponse(Type.Ref("MarketplaceTemplateEnvelope")), 404: problemResponse("NotFound"), 503: problemResponse("ManagerUnavailable") } }));
    this.registerRoute("GET", "/api/agent/knowledge-bases", (_request, response) => this.listKnowledgeBases(response), routeSchema("listKnowledgeBases", { response: { 410: generic } }));
    for (const path of ["/api/agent/knowledge-bases/:knowledge_base_id/:kind", "/api/agent/knowledge-bases/:knowledge_base_id/:kind/:resource_id"]) this.registerRoute("GET", path, (_request, response) => this.listKnowledgeReadModel(response), routeSchema("knowledgeReadModel", { response: { 410: generic } }));
    this.registerRoute("GET", "/api/agent/org/tree", (request, response, caller) => this.orgTree(response, caller!), routeSchema("orgTree", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/office/scene", (_request, response, caller) => this.officeScene(response, caller!), routeSchema("officeScene", { response: { 200: generic } }));
    this.registerRoute("GET", "/api/agent/office/feed", (_request, response, caller) => this.officeFeed(response, caller!), routeSchema("officeFeed", { response: { 200: generic } }));

    const gone = (_request: IncomingMessage, _response: ServerResponse) => { throw new HttpProblem(410, "gone", "This Agent endpoint was removed; use Manager-authorized read projections or the Pi prompt API"); };
    for (const path of ["/api/agent/conversations/:conversation_id/group-dispatch", "/api/agent/conversations/:conversation_id/terminal/execute", "/api/agent/recruitments", "/api/agent/recruitments/*", "/api/agent/knowledge-bases/*"]) this.registerRoute(["GET", "POST", "PUT", "PATCH", "DELETE"], path, gone, routeSchema("removedAgentEndpoint", { hide: true, response: { 410: generic } }));
  }

  private registerRoute(method: string | string[], url: string, handler: AgentRouteHandler, schema: Record<string, unknown>, authenticated = true): void {
    const routeSchemaWithAuth = { ...schema, security: authenticated ? [{ bearerAuth: [] }] : [] };
    this.app.route({
      method: method as never,
      url,
      schema: routeSchemaWithAuth as never,
      handler: async (request, reply) => {
        const raw = request.raw as BufferedRequest & { __params?: Record<string, string> };
        raw[FASTIFY_BODY] = request.body;
        reply.hijack();
        try {
          let caller: AuthenticatedCaller | undefined;
          if (authenticated) {
            try { caller = await this.options.authenticate(raw); } catch { throw new HttpProblem(401, "unauthenticated", "Authentication is required"); }
            if (!caller.callerId || !caller.tenantId || !(caller.userId ?? caller.callerId)) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant and member are required");
          }
          await handler(raw, reply.raw, caller, request);
        } catch (error) {
          this.errors += 1;
          if (!(error instanceof EventCursorStaleError)) this.options.logger?.error(error);
          this.writeError(reply.raw, error, String(request.id));
        }
      },
    });
  }

  private fastifyError(error: unknown): unknown {
    const candidate = error as { code?: string; statusCode?: number; validation?: unknown };
    if (candidate.code === "FST_ERR_CTP_INVALID_JSON_BODY") return new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
    if (candidate.code === "FST_ERR_CTP_BODY_TOO_LARGE" || candidate.statusCode === 413) return new HttpProblem(413, "request_too_large", "Request body is too large");
    if (candidate.code === "FST_ERR_VALIDATION") return new HttpProblem(422, "validation_error", "Request validation failed", candidate.validation);
    return error;
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
    const entryEmployeeId = this.optionalString(body.entry_employee_id, "entry_employee_id");
    let coordinatorEmployeeId = this.optionalString(body.coordinator_employee_id, "coordinator_employee_id");
    const solutionRef = this.optionalString(body.solution_instance_id, "solution_instance_id");
    const memberId = caller.userId ?? caller.callerId;
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : randomUUID();
    const existing = this.options.store.getConversationMetadata(id);
    if (existing) {
      if (existing.tenant_id === caller.tenantId && existing.member_id === memberId) throw new HttpProblem(409, "conversation_exists", "Conversation already exists");
      throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    }
    if (kind === "group") {
      if (entryEmployeeId) throw new HttpProblem(422, "invalid_group_employee", "Group conversations use coordinator_employee_id");
      const solution = solutionRef ? this.options.store.listSolutions(caller.tenantId, memberId).find((item) => item.solution_instance_id === solutionRef) : undefined;
      if (solutionRef && !solution) throw new HttpProblem(403, "solution_not_authorized", "Solution is not authorized locally");
      const solutionRoster = solution && Array.isArray(solution.expert_employee_ids)
        ? solution.expert_employee_ids.filter((employeeId): employeeId is string => typeof employeeId === "string")
        : [];
      if (!coordinatorEmployeeId) coordinatorEmployeeId = solutionRoster[0] ?? this.options.store.listLoadedExperts(caller.tenantId, memberId)[0]?.employee_id ?? null;
      if (!coordinatorEmployeeId) throw new HttpProblem(403, "coordinator_not_authorized", "No authorized employee is available as coordinator");
      if (solutionRoster.length > 0 && !solutionRoster.includes(coordinatorEmployeeId)) throw new HttpProblem(403, "coordinator_not_authorized", "Coordinator is not in the authorized solution roster");
      this.requireAuthorizedEmployee(coordinatorEmployeeId, caller);
    } else {
      if (coordinatorEmployeeId || solutionRef) throw new HttpProblem(422, "invalid_conversation_collaboration", "Only group conversations accept coordinator or solution references");
      if (entryEmployeeId) this.requireAuthorizedEmployee(entryEmployeeId, caller);
    }
    let schedule = null;
    if (body.schedule !== undefined && body.schedule !== null) schedule = this.parseSchedule(body.schedule);
    const metadata = this.options.store.createConversation({
      id, title, kind, labels, state: "active", schedule,
      entryEmployeeId, coordinatorEmployeeId, solutionRef,
      tenantId: caller.tenantId,
      memberId,
    });
    this.writeJson(response, 201, { data: metadata });
  }

  private requireAuthorizedEmployee(employeeId: string, caller: AuthenticatedCaller): void {
    const memberId = caller.userId ?? caller.callerId;
    const expert = this.options.store.listLoadedExperts(caller.tenantId, memberId).find((item) => item.employee_id === employeeId && !item.revoked);
    if (!expert || !this.options.store.listSnapshots(caller.tenantId, memberId).some((snapshot) => snapshot.employee_id === employeeId && snapshot.version === expert.version)) {
      throw new HttpProblem(403, "employee_not_authorized", "Employee is not authorized locally");
    }
  }

  private requireOwnedConversation(conversationId: string, caller: AuthenticatedCaller): void {
    if (!caller.tenantId) throw new HttpProblem(401, "unauthenticated", "Authenticated tenant is required");
    if (!this.options.store.getOwnedConversation(conversationId, caller.tenantId, caller.userId ?? caller.callerId)) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
  }

  private getConversation(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): void {
    const metadata = this.options.store.getOwnedConversationMetadata(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: metadata });
  }

  private async updateConversation(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const patch: Parameters<AgentSqliteStore["updateConversation"]>[1] = {};
    if (body.title !== undefined) patch.title = body.title === null ? null : this.stringField(body.title, "title", 200);
    if (body.kind !== undefined) patch.kind = this.stringField(body.kind, "kind", 64);
    if (body.labels !== undefined) patch.labels = this.stringArray(body.labels, "labels", 32);
    if (body.schedule !== undefined) patch.schedule = body.schedule === null ? null : this.parseSchedule(body.schedule);
    if (body.last_read_entry_id !== undefined) patch.lastReadEntryId = this.optionalString(body.last_read_entry_id, "last_read_entry_id");
    this.requireOwnedConversation(conversationId, caller);
    const updated = this.options.store.updateConversation(conversationId, patch);
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private getConversationState(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): void {
    const metadata = this.options.store.getOwnedConversationMetadata(conversationId, caller.tenantId!, caller.userId ?? caller.callerId);
    if (!metadata) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { conversation_id: metadata.id, state: metadata.state } });
  }

  private async updateConversationState(request: IncomingMessage, response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    const body = await this.readJson(request);
    const state = this.stringField(body.state, "state", 32) as ConversationState;
    if (!["draft", "active", "paused", "muted", "archived"].includes(state)) throw new HttpProblem(422, "invalid_state", "Unsupported conversation state");
    this.requireOwnedConversation(conversationId, caller);
    const updated = this.options.store.updateConversation(conversationId, { state });
    if (!updated) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: updated });
  }

  private async deleteConversation(response: ServerResponse, conversationId: string, caller: AuthenticatedCaller): Promise<void> {
    if (!(await this.options.host.delete(conversationId, caller.tenantId!, caller.userId ?? caller.callerId))) throw new HttpProblem(404, "conversation_not_found", "Conversation not found");
    this.writeJson(response, 200, { data: { deleted: true } });
  }

  private listExperts(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listLoadedExperts(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listSolutions(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSolutions(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private async listMarketplaceTemplates(response: ServerResponse, caller: AuthenticatedCaller, templateId?: string): Promise<void> {
    if (!this.options.managerClient?.listMarketplaceTemplates) throw new HttpProblem(503, "manager_unavailable", "Marketplace catalog is unavailable");
    let templates: MarketplaceTemplate[];
    try {
      templates = await this.options.managerClient.listMarketplaceTemplates(caller);
    } catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      if (error instanceof ManagerUnavailableError) throw new HttpProblem(503, "manager_unavailable", "Marketplace catalog is unavailable");
      throw error;
    }
    if (templateId) {
      const template = templates.find((item) => item.template_id === templateId);
      if (!template) throw new HttpProblem(404, "marketplace_template_not_found", "Marketplace template not found");
      return this.writeJson(response, 200, { data: template });
    }
    this.writeJson(response, 200, { data: templates, page: { next_cursor: null, has_more: false } });
  }
  private listKnowledgeBases(response: ServerResponse): void { throw new HttpProblem(410, "gone", "Agent knowledge base endpoints were removed; use the Pi knowledge tools"); }
  private listKnowledgeReadModel(response: ServerResponse): void { throw new HttpProblem(410, "gone", "Agent knowledge read endpoints were removed; use the Pi knowledge tools"); }
  private listSnapshots(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listSnapshots(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }
  private listOutbox(response: ServerResponse, caller: AuthenticatedCaller): void { this.writeJson(response, 200, { data: this.options.store.listUsageOutbox(caller.tenantId, caller.userId ?? caller.callerId), page: { next_cursor: null, has_more: false } }); }

  private async flushUsage(request: IncomingMessage, response: ServerResponse, caller: AuthenticatedCaller): Promise<void> {
    if (!this.options.usageFlush) throw new HttpProblem(503, "manager_unavailable", "Manager usage upload is not configured");
    const body = await this.readJson(request);
    const limit = body.limit === undefined ? 50 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpProblem(422, "invalid_limit", "limit must be an integer between 1 and 100");
    const result = await this.options.usageFlush.flush(caller, limit);
    if (result.failed.length > 0) throw new HttpProblem(503, "manager_unavailable", "Manager usage upload is unavailable", { failed: result.failed, sent: result.sent });
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
      const envVerification = skillSigningVerificationFromEnv();
      const verification = config.skill_signing_keys?.length
        ? { ...envVerification, publicKeys: config.skill_signing_keys }
        : envVerification;
      // Verify every envelope before changing projections or cache. Missing key means
      // package sync is disabled, not an invitation to accept unsigned content.
      if (signedPackages.length && !verification.publicKeys?.length && (!verification.publicKey || !verification.keyId)) throw new HttpProblem(503, "skill_signing_unconfigured", "Signed skill verification is not configured");
      if (signedPackages.length) {
        try {
          for (const envelope of signedPackages) {
            verifySignedSkillPackage(envelope, { ...verification, tenantId: caller.tenantId, memberId });
          }
        } catch (error) {
          if (error instanceof SkillVerificationError) throw new HttpProblem(503, "skill_package_invalid", "Manager returned an invalid signed skill package");
          throw error;
        }
      }
      const result = this.options.store.replaceProjections(config.experts ?? [], config.solutions ?? [], snapshots, config.revoked_ids ?? [], { tenantId: caller.tenantId!, memberId });
      if ((skillPackagesAuthoritative || Boolean(config.skill_signing_keys?.length)) && this.options.skillCache && (signedPackages.length === 0 || verification.publicKeys?.length || (verification.publicKey && verification.keyId))) {
        const experts = this.options.store.listLoadedExperts(caller.tenantId, memberId);
        const currentEmployeeIds = new Set(experts.filter((expert) => !expert.revoked).map((expert) => expert.employee_id));
        const refs = experts.filter((expert) => currentEmployeeIds.has(expert.employee_id)).flatMap((expert) => {
          const values = expert.skills;
          return Array.isArray(values) ? values.filter((ref): ref is string => typeof ref === "string") : [];
        });
        refs.push(...this.options.store.listSnapshots(caller.tenantId, memberId).filter((snapshot) => currentEmployeeIds.has(snapshot.employee_id)).flatMap((snapshot) => skillRefsForSnapshot(snapshot as { skill_refs?: unknown; skills?: unknown })));
        this.options.skillCache.reconcile({ tenantId: caller.tenantId, memberId }, signedPackages, refs, verification, { authoritative: skillPackagesAuthoritative });
      }
      this.writeJson(response, 200, { data: { ok: true, ...result } });
    } catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
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

  private async expertReadiness(response: ServerResponse, employeeId: string, caller: AuthenticatedCaller): Promise<void> {
    const id = employeeId;
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
    catch (error) {
      if (error instanceof ManagerAuthorizationError) throw new HttpProblem(error.status, error.status === 401 ? "unauthenticated" : "forbidden", error.message);
      throw new HttpProblem(503, "manager_unavailable", "Organization projection is unavailable");
    }
  }

  private officeScene(response: ServerResponse, caller: AuthenticatedCaller): void {
    const memberId = caller.userId ?? caller.callerId;
    const conversations = this.options.store.listConversations(100, undefined, caller.tenantId, memberId).items;
    const taskByEmployee = new Map<string, { title: string; conversation_id: string }>();
    for (const conversation of conversations) {
      const employeeId = conversation.entry_employee_id ?? conversation.coordinator_employee_id;
      if (!employeeId || taskByEmployee.has(employeeId)) continue;
      if (conversation.state === "active" || conversation.state === "draft") {
        taskByEmployee.set(employeeId, { title: conversation.title || (conversation.kind === "task" ? "Task" : "Conversation"), conversation_id: conversation.id });
      }
    }
    const employees = this.options.store.listLoadedExperts(caller.tenantId, memberId, true).map((expert) => {
      const task = taskByEmployee.get(expert.employee_id);
      const conversation = task ? conversations.find((item) => item.id === task.conversation_id) : undefined;
      const status = expert.revoked || ["paused", "muted", "archived"].includes(conversation?.state ?? "")
        ? "offline"
        : task && this.options.host.isPrompting(task.conversation_id) ? "working" : "ready";
      return { employee_id: expert.employee_id, display_name: expert.display_name, status, task: status === "working" ? task?.title ?? null : null, avatar_url: typeof expert.avatar_url === "string" ? expert.avatar_url : null };
    });
    const summary = {
      total: employees.length,
      working: employees.filter((employee) => employee.status === "working").length,
      ready: employees.filter((employee) => employee.status === "ready").length,
      offline: employees.filter((employee) => employee.status === "offline").length,
    };
    this.writeJson(response, 200, { data: { employees, summary } });
  }

  private officeFeed(response: ServerResponse, caller: AuthenticatedCaller): void {
    const memberId = caller.userId ?? caller.callerId;
    const events = this.options.store.listScheduledConversations()
      .filter((conversation) => conversation.tenantId === caller.tenantId && conversation.memberId === memberId)
      .map((conversation) => ({ type: "conversation_schedule", conversation_id: conversation.id, title: conversation.title ?? conversation.id, schedule: conversation.schedule }));
    this.writeJson(response, 200, { data: { events } });
  }

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
    if (mentions.length > 0 && conversation.kind !== "group") throw new HttpProblem(422, "invalid_mentions", "mentions are only supported for group conversations");
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
          conversation_id: envelope.conversation_id ?? conversationId,
          ...(envelope.source_ref ? {
            source_ref: envelope.source_ref,
            tool_call_id: envelope.tool_call_id,
            source_employee_id: envelope.source_employee_id,
            source_employee_display_name: envelope.source_employee_display_name,
            source_role: envelope.source_role,
          } : {}),
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
    const fastifyBody = (request as BufferedRequest)[FASTIFY_BODY];
    if (fastifyBody !== undefined) {
      let serialized: string;
      try { serialized = JSON.stringify(fastifyBody); } catch { throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object"); }
      if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new HttpProblem(413, "request_too_large", "Request body is too large");
      if (!fastifyBody || typeof fastifyBody !== "object" || Array.isArray(fastifyBody)) throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
      return fastifyBody as Record<string, unknown>;
    }
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
    else if (error instanceof ManagerUnavailableError) problem = { status: 503, code: "manager_unavailable", detail: error.message };
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

function redocHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><redoc spec-url=${JSON.stringify(url)}></redoc><script src="/redoc/redoc.standalone.js"></script>`;
}
