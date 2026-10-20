import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

/**
 * Desktop gateway mode: the WebView talks only to the local Agent, which keeps
 * local capabilities (identity, grants, local directories) and forwards every
 * other contract route to one fixed upstream Agent origin.
 */

/** Request headers the gateway copies upstream; credentials are passed through, never added. */
const FORWARDED_REQUEST_HEADERS = [
  "authorization", "content-type", "accept", "idempotency-key", "if-match", "last-event-id",
  "x-aiteam-reconciliation-version", "x-request-id", "traceparent",
] as const;
/** Response headers copied back; local hooks own CORS, request and trace IDs. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type", "content-length", "content-encoding", "content-disposition", "etag", "cache-control",
  "x-accel-buffering", "retry-after",
] as const;

export const AITEAM_ORIGIN_HEADER = "X-Aiteam-Origin";

export class UpstreamUnavailableError extends Error {
  constructor(message = "Upstream Agent is unavailable") {
    super(message);
    this.name = "UpstreamUnavailableError";
  }
}

export class GatewayRequestTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "GatewayRequestTooLargeError";
  }
}

/** Accept only a bare http(s) origin: no path, credentials, query or fragment. */
export function parseUpstreamOrigin(value: string | undefined): string | undefined {
  return parseUpstreamUrl(value)?.origin;
}

function parseUpstreamUrl(value: string | undefined): URL | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error("AITEAM_AGENT_UPSTREAM_URL must be an absolute http(s) origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[?#]/u.test(trimmed)) {
    throw new Error("AITEAM_AGENT_UPSTREAM_URL must be a bare http(s) origin without path, credentials, query or fragment");
  }
  return url;
}

export interface UpstreamJsonResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface UpstreamGatewayOptions {
  /** Time allowed to open the TCP/TLS connection. */
  connectTimeoutMs?: number;
  /** Time allowed until upstream response headers arrive on forwarded calls. */
  headersTimeoutMs?: number;
}

export class UpstreamGateway {
  readonly origin: string;
  private readonly url: URL;
  private readonly agent: HttpAgent;
  private readonly connectTimeoutMs: number;
  private readonly headersTimeoutMs: number;

  constructor(origin: string, options: UpstreamGatewayOptions = {}) {
    const parsed = parseUpstreamUrl(origin);
    if (!parsed) throw new Error("Upstream origin is required");
    this.origin = parsed.origin;
    this.url = parsed;
    this.agent = this.url.protocol === "https:" ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.headersTimeoutMs = options.headersTimeoutMs ?? 120_000;
  }

  close(): void { this.agent.destroy(); }

  /**
   * Stream one request upstream and pipe the response back without buffering
   * (SSE and binary downloads included). Rejects with UpstreamUnavailableError
   * only while no response bytes were written, so callers can still answer 502.
   */
  forward(request: IncomingMessage, response: ServerResponse, options: { path?: string; body?: string | Buffer; responseHeaders?: Record<string, string>; maxBodyBytes?: number } = {}): Promise<void> {
    const target = this.target(options.path ?? request.url ?? "/");
    const headers = copyHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
    // A replaced body gets its own length; a streamed body keeps the client's
    // length or falls back to chunked encoding chosen by node:http.
    if (options.body !== undefined) headers["content-length"] = Buffer.byteLength(options.body);
    else if (request.headers["content-length"] !== undefined) headers["content-length"] = request.headers["content-length"];
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(headersTimer);
        if (error) reject(error); else resolve();
      };
      const upstream = this.send(target, request.method ?? "GET", headers);
      const headersTimer = setTimeout(() => upstream.destroy(new UpstreamUnavailableError("Upstream Agent did not respond in time")), this.headersTimeoutMs);
      upstream.once("response", (incoming) => {
        clearTimeout(headersTimer);
        if (response.destroyed) { incoming.destroy(); done(); return; }
        const out = copyHeaders(incoming.headers, FORWARDED_RESPONSE_HEADERS);
        response.writeHead(incoming.statusCode ?? 502, { ...out, ...options.responseHeaders, [AITEAM_ORIGIN_HEADER]: "upstream" });
        // SSE must reach the client immediately; there is no compression or buffering here.
        response.flushHeaders();
        incoming.pipe(response);
        incoming.on("error", () => { response.destroy(); done(); });
        // A torn-down upstream socket (gateway shutdown, upstream restart) must
        // end the client stream too, so the WebView reconnects instead of hanging.
        incoming.once("close", () => { if (!incoming.complete) { response.destroy(); done(); } });
        response.once("finish", () => done());
      });
      upstream.on("error", (error) => {
        if (!response.headersSent) { done(error instanceof UpstreamUnavailableError || error instanceof GatewayRequestTooLargeError ? error : new UpstreamUnavailableError()); return; }
        response.destroy();
        done();
      });
      // A closed client tears down the upstream call, including long-lived SSE.
      response.once("close", () => {
        if (!response.writableFinished) upstream.destroy();
        done();
      });
      if (options.body !== undefined) upstream.end(options.body);
      else {
        let received = 0;
        request.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (options.maxBodyBytes !== undefined && received > options.maxBodyBytes) upstream.destroy(new GatewayRequestTooLargeError());
        });
        request.on("error", () => upstream.destroy());
        request.pipe(upstream);
      }
    });
  }

  /** Small buffered JSON call used by gateway-side preprocessing. */
  async requestJson(method: string, path: string, headers: Record<string, string | undefined>, options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {}): Promise<UpstreamJsonResponse> {
    const target = this.target(path);
    const outgoing: OutgoingHttpHeaders = { accept: "application/json" };
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) outgoing[name.toLowerCase()] = value;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (payload !== undefined) {
      outgoing["content-type"] = "application/json";
      outgoing["content-length"] = Buffer.byteLength(payload);
    }
    return new Promise<UpstreamJsonResponse>((resolve, reject) => {
      const upstream = this.send(target, method, outgoing);
      const fail = (error?: unknown) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error instanceof UpstreamUnavailableError ? error : new UpstreamUnavailableError());
      };
      const onAbort = () => upstream.destroy(new UpstreamUnavailableError("Upstream request was cancelled"));
      const timer = setTimeout(() => upstream.destroy(new UpstreamUnavailableError("Upstream Agent did not respond in time")), options.timeoutMs ?? 5_000);
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
      upstream.on("error", fail);
      upstream.once("response", (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 4 * 1024 * 1024)) { incoming.destroy(); upstream.destroy(new UpstreamUnavailableError("Upstream response is too large")); return; }
          chunks.push(chunk);
        });
        incoming.on("error", fail);
        incoming.once("end", () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
          resolve({ status: incoming.statusCode ?? 502, headers: incoming.headers, body });
        });
      });
      upstream.end(payload);
    });
  }

  private target(path: string): URL {
    // Origin-form only: an absolute-form or scheme-relative request target must
    // never redirect the gateway to another host.
    if (!path.startsWith("/") || path.startsWith("//")) throw new UpstreamUnavailableError("Invalid upstream request target");
    const target = new URL(path, this.url);
    if (target.origin !== this.origin) throw new UpstreamUnavailableError("Invalid upstream request target");
    return target;
  }

  private send(target: URL, method: string, headers: OutgoingHttpHeaders) {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, { method, headers: { ...headers, host: target.host }, agent: this.agent });
    upstream.once("socket", (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => upstream.destroy(new UpstreamUnavailableError("Upstream Agent connection timed out")), this.connectTimeoutMs);
      socket.once("connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    return upstream;
  }
}

function copyHeaders(source: IncomingHttpHeaders, names: readonly string[]): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
