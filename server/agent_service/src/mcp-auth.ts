/**
 * Authentication for personal MCP servers (design 2026-11-18 MCP鉴权与配置导入).
 *
 * The MCP server challenges; the member signs in on the provider's own page (OAuth) or enters a token the provider
 * issued (bearer). This Agent keeps the result in an encrypted file on the member's machine and attaches it to calls.
 * Tokens, authorization codes, PKCE verifiers and OAuth state never reach the model, the approval record, the event
 * stream, logs, Manager or Operator. Modelled on pi-mcp-adapter (mcp-oauth-provider.ts, mcp-callback-server.ts).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auth as sdkAuth, discoverOAuthServerInfo, extractWWWAuthenticateParams,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { LocalCapabilityAuth } from "./storage/sqlite.js";

export interface McpOwner { tenantId: string; memberId: string }
/** A client id the provider issued by hand (its developer console), used when it does not allow dynamic registration. */
export interface McpPreregisteredClient { client_id: string; client_secret?: string }
export interface McpBearerCredential { token: string; header?: string }

/** Plaintext of one credential file. */
export interface McpCredential {
  /** The MCP endpoint this credential belongs to; a different URL never receives it. */
  url: string;
  auth: "oauth" | "bearer";
  token?: string;
  header?: string;
  tokens?: OAuthTokens;
  /** ms epoch when `tokens` were obtained, to tell when they expire. */
  obtained_at?: number;
  client?: OAuthClientInformationMixed & { redirect_uris?: string[] };
  /** Hand-entered client of a member-added MCP. */
  preregistered?: McpPreregisteredClient;
  /** Platform server id whose provider-issued client Manager holds; fetched only to sign in / refresh, never stored. */
  catalog_client?: string;
}

export const MCP_CLIENT_NAME = "AI Team";
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "cookie", "mcp-session-id", "mcp-protocol-version", "transfer-encoding"]);

export function validBearerHeader(header: string | undefined): boolean {
  return header === undefined || header === "" || (HEADER_RE.test(header) && !FORBIDDEN_HEADERS.has(header.toLowerCase()));
}

/** Request headers carrying a bearer credential: `Authorization: Bearer <t>` by default, else the raw token in the named header. */
export function bearerHeaders(credential: McpBearerCredential): Record<string, string> {
  const header = credential.header?.trim();
  return !header || header.toLowerCase() === "authorization" ? { Authorization: `Bearer ${credential.token}` } : { [header]: credential.token };
}

function boundUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

/**
 * AES-256-GCM files under `<dataRoot>/mcp-credentials/`, one per (member, MCP ref); the key sits in
 * `<dataRoot>/mcp-credentials.key`. Both 0600 inside a 0700 data root. This guards against copying or uploading the
 * folder by mistake, not against another program running as the same OS user (design §9).
 */
export class McpCredentialStore {
  private readonly dir: string;
  private readonly keyPath: string;
  private key?: Buffer;

  constructor(dataRoot: string) {
    this.dir = join(dataRoot, "mcp-credentials");
    this.keyPath = join(dataRoot, "mcp-credentials.key");
  }

  private secret(): Buffer {
    if (this.key) return this.key;
    if (!existsSync(this.keyPath)) {
      try { writeFileSync(this.keyPath, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" }); } catch { /* another writer won */ }
    }
    const key = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error("MCP credential key is invalid");
    this.key = key;
    return key;
  }

  private id(owner: McpOwner, ref: string): string {
    return createHash("sha256").update(`${owner.tenantId}\0${owner.memberId}\0${ref}`).digest("hex");
  }

  private path(owner: McpOwner, ref: string): string { return join(this.dir, `${this.id(owner, ref)}.json`); }

  /** The stored credential when it belongs to `url`; undefined when absent, unreadable or bound to another URL. */
  get(owner: McpOwner, ref: string, url: string): McpCredential | undefined {
    const path = this.path(owner, ref);
    if (!existsSync(path)) return undefined;
    try {
      const box = JSON.parse(readFileSync(path, "utf8")) as { v: number; iv: string; tag: string; data: string };
      const decipher = createDecipheriv("aes-256-gcm", this.secret(), Buffer.from(box.iv, "base64"));
      decipher.setAAD(Buffer.from(this.id(owner, ref)));
      decipher.setAuthTag(Buffer.from(box.tag, "base64"));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8")) as McpCredential;
      return boundUrl(value.url) === boundUrl(url) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  put(owner: McpOwner, ref: string, credential: McpCredential): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.dir, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secret(), iv);
    cipher.setAAD(Buffer.from(this.id(owner, ref)));
    const data = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    const path = this.path(owner, ref);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
    renameSync(temp, path);
  }

  /** Read-modify-write; `change` returning undefined deletes the file. */
  update(owner: McpOwner, ref: string, url: string, change: (current: McpCredential | undefined) => McpCredential | undefined): void {
    const next = change(this.get(owner, ref, url));
    if (next) this.put(owner, ref, next); else this.delete(owner, ref);
  }

  delete(owner: McpOwner, ref: string): void {
    rmSync(this.path(owner, ref), { force: true });
  }
}

export interface McpProbe {
  auth: LocalCapabilityAuth;
  /** oauth: host of the provider's sign-in page, shown to the member before they go there. */
  auth_host?: string;
  /** oauth: scope from the server's challenge. */
  scope?: string;
  resourceMetadataUrl?: string;
}

/**
 * Asks the server once, without credentials, whether it needs authentication: 2xx → none; 401 with discoverable
 * OAuth metadata → oauth; any other 401 → bearer. Throws when the server cannot be reached or answers otherwise.
 */
export async function probeMcpAuth(url: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<McpProbe> {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchFn(url, {
    method: "POST",
    redirect: "error",
    signal: combined,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aiteam-probe", version: "1.0.0" } } }),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return { auth: "none" };
  if (response.status !== 401) throw new Error(`MCP probe failed with status ${response.status}`);
  const challenge = extractWWWAuthenticateParams(response);
  try {
    const info = await discoverOAuthServerInfo(url, { ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}), fetchFn });
    const endpoint = info.authorizationServerMetadata?.authorization_endpoint;
    if (endpoint) {
      return {
        auth: "oauth", auth_host: new URL(endpoint).host,
        ...(challenge.scope ? { scope: challenge.scope } : {}),
        ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl.toString() } : {}),
      };
    }
  } catch { /* no usable OAuth metadata: a plain token is expected */ }
  return { auth: "bearer" };
}

/** Thrown when a call needs the member to sign in again; never opens a browser by itself. */
export class McpLoginRequiredError extends Error {
  constructor() { super("MCP sign-in required"); this.name = "McpLoginRequiredError"; }
}
export class McpLoginError extends Error {
  constructor(readonly reason: "timeout" | "cancelled" | "denied" | "failed", message = "MCP sign-in did not complete") { super(message); this.name = "McpLoginError"; }
}

interface ProviderOptions {
  store: McpCredentialStore;
  owner: McpOwner;
  ref: string;
  url: string;
  redirectUrl?: string;
  scope?: string;
  /** Hand-entered / platform client; when absent the Agent registers itself dynamically as «AI Team». */
  client?: () => Promise<McpPreregisteredClient | undefined>;
  /** Only an explicit sign-in may send the member to the provider; calls fail with McpLoginRequiredError instead. */
  state?: string;
}

/** The SDK's OAuth client provider bound to one member's MCP; tokens and the registered client persist in the credential file. */
export class AgentOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private verifier?: string;

  constructor(private readonly options: ProviderOptions) {}

  get redirectUrl(): string | undefined { return this.options.redirectUrl; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: MCP_CLIENT_NAME,
      redirect_uris: this.options.redirectUrl ? [this.options.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scope ? { scope: this.options.scope } : {}),
    };
  }

  state(): string {
    if (!this.options.state) throw new McpLoginRequiredError();
    return this.options.state;
  }

  private read(): McpCredential | undefined { return this.options.store.get(this.options.owner, this.options.ref, this.options.url); }

  private write(change: (current: McpCredential) => McpCredential | undefined): void {
    this.options.store.update(this.options.owner, this.options.ref, this.options.url, (current) => change(current?.auth === "oauth" ? current : { url: this.options.url, auth: "oauth" }));
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = this.read();
    const fixed = stored?.preregistered ?? await this.options.client?.();
    if (fixed?.client_id) return { client_id: fixed.client_id, ...(fixed.client_secret ? { client_secret: fixed.client_secret } : {}) };
    const client = stored?.client;
    if (!client) return undefined;
    // A sign-in must use a registration that knows today's callback (the Agent port can change); a refresh may not.
    if (this.options.state && this.options.redirectUrl && !(client.redirect_uris ?? []).includes(this.options.redirectUrl)) return undefined;
    return client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write((current) => ({ ...current, client: { ...info, redirect_uris: "redirect_uris" in info && Array.isArray(info.redirect_uris) ? info.redirect_uris : this.options.redirectUrl ? [this.options.redirectUrl] : [] } }));
  }

  tokens(): OAuthTokens | undefined {
    const stored = this.read();
    return stored?.auth === "oauth" ? stored.tokens : undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write((current) => ({ ...current, tokens, obtained_at: Date.now() }));
  }

  redirectToAuthorization(url: URL): void {
    if (!this.options.state) throw new McpLoginRequiredError();
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }

  codeVerifier(): string {
    if (!this.verifier) throw new McpLoginError("failed");
    return this.verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") { this.verifier = undefined; return; }
    if (scope === "discovery") return;
    this.write((current) => {
      const next = { ...current };
      if (scope === "all" || scope === "tokens") { delete next.tokens; delete next.obtained_at; }
      if (scope === "all" || scope === "client") delete next.client;
      return next;
    });
  }
}

export type McpLoginStatus = "pending" | "completed" | "failed";
/** What the desktop shows while the member signs in; holds no secret. */
export interface McpLogin {
  login_id: string;
  ref: string;
  status: McpLoginStatus;
  authorization_url: string;
  auth_host: string;
  expires_at: string;
  error?: "timeout" | "cancelled" | "denied" | "failed";
}

interface LoginSession {
  view: McpLogin;
  owner: McpOwner;
  approvalId?: string;
  url: string;
  scope?: string;
  resourceMetadataUrl?: string;
  provider: AgentOAuthProvider;
  state: string;
  done: Promise<void>;
  resolve: () => void;
  reject: (error: McpLoginError) => void;
  timer: NodeJS.Timeout;
  /** Run after a successful sign-in (e.g. finishing an install started from the desktop). */
  onDone?: () => Promise<void>;
}

export interface LoginOptions {
  scope?: string;
  resourceMetadataUrl?: string;
  client?: () => Promise<McpPreregisteredClient | undefined>;
  /** Hand-entered client to keep with this member's credential (member-added MCP). */
  preregistered?: McpPreregisteredClient;
  /** Platform catalog server id whose client Manager holds. */
  catalogClient?: string;
  approvalId?: string;
  signal?: AbortSignal;
  onDone?: () => Promise<void>;
}

export function openInBrowser(url: string): void {
  if (!/^https?:\/\//iu.test(url)) return;
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* the desktop offers the link as a fallback */ }
}

/**
 * Sign-in sessions and the credential store of this Agent. The provider redirects the member's browser to
 * `http://127.0.0.1:<port>/api/agent/mcp-auth/callback`: the member's own browser reaching their own machine, not an
 * inbound control-plane connection. A one-time `state` (10 minutes) plus PKCE binds the callback to the session.
 */
export class McpAuthService {
  private readonly sessions = new Map<string, LoginSession>();
  private callbackBase?: string;
  private readonly open: (url: string) => void;
  private readonly ttlMs: number;
  private readonly fetchFn?: typeof fetch;

  constructor(readonly credentials: McpCredentialStore, options: { openBrowser?: (url: string) => void; loginTtlMs?: number; fetchFn?: typeof fetch } = {}) {
    this.open = options.openBrowser ?? openInBrowser;
    this.ttlMs = options.loginTtlMs ?? 10 * 60_000;
    this.fetchFn = options.fetchFn;
  }

  /** Set once the HTTP server listens, e.g. `http://127.0.0.1:56392`. */
  setCallbackBase(base: string): void { this.callbackBase = base.replace(/\/$/u, ""); }

  get redirectUrl(): string | undefined { return this.callbackBase ? `${this.callbackBase}/api/agent/mcp-auth/callback` : undefined; }

  /** Provider for calls: refreshes silently, never sends the member to the provider. */
  provider(owner: McpOwner, ref: string, url: string, options: { scope?: string; client?: () => Promise<McpPreregisteredClient | undefined> } = {}): AgentOAuthProvider {
    return new AgentOAuthProvider({ store: this.credentials, owner, ref, url, redirectUrl: this.redirectUrl, ...options });
  }

  /**
   * Signs in: reuses valid (or refreshable) tokens, otherwise opens the provider's page and returns the pending login.
   * `done` settles when the browser comes back (or fails / times out / is cancelled).
   */
  async login(owner: McpOwner, ref: string, url: string, options: LoginOptions = {}): Promise<{ login?: McpLogin; done: Promise<void> }> {
    const redirectUrl = this.redirectUrl;
    if (!redirectUrl) throw new McpLoginError("failed", "MCP sign-in callback is not available");
    if (options.preregistered || options.catalogClient) {
      this.credentials.update(owner, ref, url, (current) => {
        const next: McpCredential = { ...(current?.auth === "oauth" ? current : {}), url, auth: "oauth" };
        delete next.preregistered; delete next.catalog_client; delete next.client;
        return { ...next, ...(options.preregistered ? { preregistered: options.preregistered } : {}), ...(options.catalogClient ? { catalog_client: options.catalogClient } : {}) };
      });
    }
    const state = randomBytes(32).toString("base64url");
    const provider = new AgentOAuthProvider({ store: this.credentials, owner, ref, url, redirectUrl, state, ...(options.scope ? { scope: options.scope } : {}), ...(options.client ? { client: options.client } : {}) });
    const result = await sdkAuth(provider, {
      serverUrl: url,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.resourceMetadataUrl ? { resourceMetadataUrl: new URL(options.resourceMetadataUrl) } : {}),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
    });
    if (result === "AUTHORIZED" || !provider.authorizationUrl) {
      await options.onDone?.();
      return { done: Promise.resolve() };
    }
    let resolve!: () => void;
    let reject!: (error: McpLoginError) => void;
    const done = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    done.catch(() => undefined);
    const authorizationUrl = provider.authorizationUrl.toString();
    const session: LoginSession = {
      view: {
        login_id: randomUUID(), ref, status: "pending", authorization_url: authorizationUrl,
        auth_host: provider.authorizationUrl.host, expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
      },
      owner, url, provider, state, done, resolve, reject,
      ...(options.approvalId ? { approvalId: options.approvalId } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl } : {}),
      ...(options.onDone ? { onDone: options.onDone } : {}),
      timer: setTimeout(() => this.finish(session, new McpLoginError("timeout")), this.ttlMs),
    };
    session.timer.unref?.();
    // One pending sign-in per member and MCP: a newer request replaces the older one.
    for (const other of this.sessions.values()) {
      if (other.view.status === "pending" && other.owner.tenantId === owner.tenantId && other.owner.memberId === owner.memberId && other.view.ref === ref) this.finish(other, new McpLoginError("cancelled"));
    }
    this.sessions.set(state, session);
    options.signal?.addEventListener("abort", () => this.finish(session, new McpLoginError("cancelled")), { once: true });
    this.open(authorizationUrl);
    return { login: { ...session.view }, done };
  }

  /** Browser callback. Returns whether the sign-in completed; never reveals why to the page beyond a short reason. */
  async callback(query: { state?: string | null; code?: string | null; error?: string | null }): Promise<boolean> {
    const session = query.state ? this.sessions.get(query.state) : undefined;
    if (!session || session.view.status !== "pending") return false;
    if (query.error || !query.code) {
      this.finish(session, new McpLoginError(query.error === "access_denied" ? "denied" : "failed"));
      return false;
    }
    try {
      const result = await sdkAuth(session.provider, {
        serverUrl: session.url,
        authorizationCode: query.code,
        ...(session.scope ? { scope: session.scope } : {}),
        ...(session.resourceMetadataUrl ? { resourceMetadataUrl: new URL(session.resourceMetadataUrl) } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      });
      if (result !== "AUTHORIZED") throw new McpLoginError("failed");
      await session.onDone?.();
      this.finish(session);
      return true;
    } catch {
      this.finish(session, new McpLoginError("failed"));
      return false;
    }
  }

  private finish(session: LoginSession, error?: McpLoginError): void {
    if (session.view.status !== "pending") return;
    clearTimeout(session.timer);
    session.view.status = error ? "failed" : "completed";
    if (error) { session.view.error = error.reason; session.reject(error); } else session.resolve();
    // Keep the finished view briefly so the desktop can read the outcome; the state can no longer be used.
    const keep = setTimeout(() => this.sessions.delete(session.state), 60_000);
    keep.unref?.();
  }

  get(owner: McpOwner, loginId: string): McpLogin | undefined {
    const session = [...this.sessions.values()].find((item) => item.view.login_id === loginId && item.owner.tenantId === owner.tenantId && item.owner.memberId === owner.memberId);
    return session ? { ...session.view } : undefined;
  }

  forApproval(owner: McpOwner, approvalId: string): McpLogin | undefined {
    const session = [...this.sessions.values()].reverse().find((item) => item.approvalId === approvalId && item.owner.tenantId === owner.tenantId && item.owner.memberId === owner.memberId);
    return session ? { ...session.view } : undefined;
  }

  /** Opens the stored sign-in page again (the member closed the tab, or the first open failed). The desktop passes only the id. */
  reopen(owner: McpOwner, loginId: string): boolean {
    const session = [...this.sessions.values()].find((item) => item.view.login_id === loginId && item.owner.tenantId === owner.tenantId && item.owner.memberId === owner.memberId);
    if (!session || session.view.status !== "pending") return false;
    this.open(session.view.authorization_url);
    return true;
  }

  cancel(owner: McpOwner, loginId: string): boolean {
    const session = [...this.sessions.values()].find((item) => item.view.login_id === loginId && item.owner.tenantId === owner.tenantId && item.owner.memberId === owner.memberId);
    if (!session || session.view.status !== "pending") return false;
    this.finish(session, new McpLoginError("cancelled"));
    return true;
  }

  /** Sign-in status of an installed OAuth / bearer MCP, for the settings page. */
  status(owner: McpOwner, ref: string, url: string, auth: LocalCapabilityAuth): { auth_status: "none" | "signed_in" | "needs_login" | "token_set" | "needs_token"; auth_expires_at: string | null } {
    if (auth === "none") return { auth_status: "none", auth_expires_at: null };
    const stored = this.credentials.get(owner, ref, url);
    if (auth === "bearer") return { auth_status: stored?.token ? "token_set" : "needs_token", auth_expires_at: null };
    const tokens = stored?.auth === "oauth" ? stored.tokens : undefined;
    if (!tokens?.access_token) return { auth_status: "needs_login", auth_expires_at: null };
    const expires = tokens.expires_in && stored?.obtained_at ? stored.obtained_at + tokens.expires_in * 1000 : undefined;
    // Expired without a refresh token: the next call cannot succeed.
    if (expires !== undefined && expires <= Date.now() && !tokens.refresh_token) return { auth_status: "needs_login", auth_expires_at: new Date(expires).toISOString() };
    return { auth_status: "signed_in", auth_expires_at: expires !== undefined ? new Date(expires).toISOString() : null };
  }
}
