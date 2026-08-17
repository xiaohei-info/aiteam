import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  ConversationBusyError,
  type PiEventEnvelope,
  SessionHost,
} from "../pi/session-host.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  IdempotencyConflictError,
  IdempotencyUnknownError,
  type AgentSqliteStore,
} from "../storage/sqlite.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface AuthenticatedCaller {
  callerId: string;
}

export type AuthenticateRequest = (request: IncomingMessage) => AuthenticatedCaller | Promise<AuthenticatedCaller>;

export interface AgentHttpServerOptions {
  host: SessionHost;
  store: AgentSqliteStore;
  authenticate: AuthenticateRequest;
  logger?: Pick<Console, "error">;
}

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
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
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") {
        return this.writeJson(response, 200, { data: { status: "ok" } });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        return this.writeJson(response, 200, { data: { ready: true } });
      }

      const route = this.matchConversationRoute(url.pathname);
      if (!route) throw new HttpProblem(404, "not_found", "Route not found");
      const caller = await this.options.authenticate(request);
      if (!caller.callerId) throw new HttpProblem(401, "unauthenticated", "Authenticated caller is required");

      if (route.action === "events" && request.method === "GET") {
        return await this.events(request, response, route.conversationId, url.searchParams.get("after"));
      }
      if (route.action === "entries" && request.method === "GET") {
        const entries = await this.options.host.entries(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, entries } });
      }
      if (route.action === "prompt" && request.method === "POST") {
        return await this.prompt(request, response, route.conversationId, caller.callerId);
      }
      if (route.action === "abort" && request.method === "POST") {
        const aborted = await this.options.host.abort(route.conversationId);
        return this.writeJson(response, 200, { data: { conversation_id: route.conversationId, aborted } });
      }
      throw new HttpProblem(405, "method_not_allowed", "Method not allowed");
    } catch (error) {
      this.options.logger?.error(error);
      this.writeError(response, error);
    }
  }

  private async prompt(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
    callerId: string,
  ): Promise<void> {
    const key = this.header(request, "idempotency-key");
    if (!key || key.length > 256) {
      throw new HttpProblem(400, "invalid_idempotency_key", "Idempotency-Key is required and must be <= 256 characters");
    }
    const payload = await this.readJson(request);
    const text = payload.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 200_000) {
      throw new HttpProblem(400, "invalid_prompt", "text must be a non-empty string <= 200000 characters");
    }
    const images = payload.images;
    if (
      images !== undefined &&
      (!Array.isArray(images) ||
        images.length > 8 ||
        images.some(
          (image) =>
            !image ||
            typeof image !== "object" ||
            (image as Record<string, unknown>).type !== "image" ||
            typeof (image as Record<string, unknown>).data !== "string" ||
            typeof (image as Record<string, unknown>).mimeType !== "string",
        ))
    ) {
      throw new HttpProblem(400, "invalid_images", "images must contain at most 8 {type, data, mimeType} objects");
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ text, images: images ?? [] }))
      .digest("hex");

    const receipt = this.options.store.reservePrompt({
      conversationId,
      callerId,
      key,
      fingerprint,
    });
    if (!receipt.isNew) {
      return this.writeAccepted(response, conversationId, key);
    }

    // The first accepted request owns execution. A repeated accepted key only receives the same receipt.
    void this.runPrompt(conversationId, callerId, key, text, images);
    this.writeAccepted(response, conversationId, key);
  }

  private async runPrompt(
    conversationId: string,
    callerId: string,
    key: string,
    text: string,
    images: unknown,
  ): Promise<void> {
    try {
      const lastEntryId = await this.options.host.prompt(conversationId, text, this.asImages(images));
      this.options.store.markCompleted(conversationId, callerId, key, lastEntryId);
    } catch (error) {
      if (error instanceof ConversationBusyError) return;
      this.options.store.markUnknown(conversationId, callerId, key);
      this.options.logger?.error(error);
    }
  }

  private async events(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
    after: string | null,
  ): Promise<void> {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");

    let closed = false;
    const write = (envelope: PiEventEnvelope) => {
      if (closed || response.writableEnded) return;
      response.write(`id: ${envelope.id}\nevent: pi\ndata: ${JSON.stringify(envelope.event)}\n\n`);
    };
    const unsubscribe = await this.options.host.subscribe(conversationId, write, after ?? this.header(request, "last-event-id"));
    const close = () => {
      closed = true;
      unsubscribe();
    };
    request.once("close", close);
    response.once("close", close);
  }

  private matchConversationRoute(pathname: string):
    | { conversationId: string; action: "prompt" | "events" | "abort" | "entries" }
    | undefined {
    const match = pathname.match(/^\/api\/agent\/conversations\/([^/]+)\/(prompt|events|abort|entries)$/);
    if (!match) return undefined;
    return {
      conversationId: decodeURIComponent(match[1]),
      action: match[2] as "prompt" | "events" | "abort" | "entries",
    };
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
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("JSON object required");
      }
      return value as Record<string, unknown>;
    } catch {
      throw new HttpProblem(400, "invalid_json", "Request body must be a JSON object");
    }
  }

  private asImages(value: unknown): ImageContent[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value as ImageContent[];
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private writeAccepted(response: ServerResponse, conversationId: string, key: string): void {
    this.writeJson(response, 202, {
      data: {
        conversation_id: conversationId,
        accepted: true,
        idempotency_key: key,
      },
    });
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Length": Buffer.byteLength(payload),
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(payload);
  }

  private writeError(response: ServerResponse, error: unknown): void {
    if (response.writableEnded) return;
    if (error instanceof HttpProblem) {
      return this.writeJson(response, error.status, {
        type: "about:blank",
        title: error.code,
        status: error.status,
        code: error.code,
        detail: error.message,
      });
    }
    if (error instanceof IdempotencyConflictError) {
      return this.writeJson(response, 409, {
        type: "about:blank",
        title: "idempotency_conflict",
        status: 409,
        code: "idempotency_conflict",
        detail: error.message,
      });
    }
    if (error instanceof IdempotencyUnknownError) {
      return this.writeJson(response, 409, {
        type: "about:blank",
        title: "idempotency_unknown",
        status: 409,
        code: "idempotency_unknown",
        detail: error.message,
      });
    }
    this.writeJson(response, 500, {
      type: "about:blank",
      title: "internal_error",
      status: 500,
      code: "internal_error",
      detail: "Internal server error",
    });
  }
}
