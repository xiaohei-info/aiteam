import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ConversationBusyError, EventCursorStaleError, InvalidEventCursorError, type PiEventEnvelope, SessionHost } from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IdempotencyConflictError, IdempotencyUnknownError, type AgentSqliteStore } from "../storage/sqlite.js";
import type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";
export type { AuthenticatedCaller, AuthenticateRequest } from "./auth.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface AgentHttpServerOptions {
  host: SessionHost;
  store: AgentSqliteStore;
  authenticate: AuthenticateRequest;
  runtimeReady?: () => boolean | Promise<boolean>;
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
      if (!route) throw new HttpProblem(404, "not_found", "Route not found");
      let caller: AuthenticatedCaller;
      try {
        caller = await this.options.authenticate(request);
      } catch {
        throw new HttpProblem(401, "unauthenticated", "Authentication is required");
      }
      if (!caller.callerId) throw new HttpProblem(401, "unauthenticated", "Authenticated caller is required");

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
    "/api/agent/conversations/{conversation_id}/abort": { post: { operationId: "abortConversation", responses: { "200": { description: "Abort result" } } } },
  },
};

function swaggerHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><div id="app"></div><script>SwaggerUIBundle({url:${JSON.stringify(url)},dom_id:'#app'})</script>`;
}
function redocHtml(url: string): string {
  return `<!doctype html><title>AI Team Agent API</title><redoc spec-url=${JSON.stringify(url)}></redoc><script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>`;
}
