import { readFileSync, statSync } from "node:fs";
import { CustomSkillStore, CustomSkillError, CustomSkillPreview, CustomSkillPackage, clawHubCandidates, clawHubParts, clawHubSecurity, fetchClawHubSkill, fetchSkillFromUrl, normalizeSkillAtRoot, normalizeSkillPackage, readSkillFile, readSkillFolder, scanSkillRoots, searchClawHubSkills, searchGithubSkills, skillContentHash, toLocalPath, unzipEntries } from "./custom-skills.js";
import type { ClawHubCandidate, ClawHubSecurity } from "./custom-skills.js";

/** 北向用的 ClawHub 候选/安全结构（避免直接把内部类型暴露到 HTTP 层）。 */
export type CustomSkillClawHubCandidate = ClawHubCandidate;
export type CustomSkillClawHubSecurity = ClawHubSecurity;
export { CustomSkillError } from "./custom-skills.js";
import { readFile as readFileAsync } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MCP_TIMEOUT_MS, type AgentSqliteStore, type CapabilityResolution, type FrozenSnapshot, type LocalCapability, type LocalCapabilityAuth } from "./storage/sqlite.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpLoginError, McpLoginRequiredError, bearerHeaders, probeMcpAuth, validBearerHeader,
  type McpAuthService, type McpBearerCredential, type McpLogin, type McpPreregisteredClient, type McpProbe,
} from "./mcp-auth.js";
import { AUTO_INSTALL_APPROVER } from "./approval-service.js";
import { AutomationError, type TaskOwner } from "./storage/automation-tasks.js";
import { SkillVerificationError } from "./skills.js";

interface LocalConnector extends TaskOwner {
  connector_id: string; display_name: string; url: string; tools: string[]; token_env?: string;
}
/** Explicit local installation, not ambient MCP discovery. Manager snapshots remain the authorization authority. */
export function localConnectors(owner: TaskOwner): LocalConnector[] {
  const path = process.env.AITEAM_CONNECTORS_FILE;
  if (!path) return [];
  try {
    const stat = statSync(path);
    if (stat.size > 256_000 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || rows.length > 100) throw new Error();
    return rows.map((row: LocalConnector) => {
      const url = new URL(row.url);
      if (!row.tenantId || !row.memberId || !/^[a-z][a-z0-9_-]{0,63}$/.test(row.connector_id) || typeof row.display_name !== "string" || row.display_name.length > 120) throw new Error();
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) || url.username || url.password || url.hash || url.search) throw new Error();
      if (!Array.isArray(row.tools) || !row.tools.length || row.tools.some(t => typeof t !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(t))) throw new Error();
      if (row.token_env && !/^AITEAM_CONNECTOR_[A-Z0-9_]+$/.test(row.token_env)) throw new Error();
      return row;
    }).filter(row => row.tenantId === owner.tenantId && row.memberId === owner.memberId);
  } catch { throw new AutomationError(503, "connector_configuration_invalid", "Local connector installation is unavailable"); }
}

function permitsConnectorTool(snapshot: FrozenSnapshot, id: string): boolean {
  const policy = snapshot.tool_policy as { allowed_tools?: unknown } | undefined;
  const allowed = policy?.allowed_tools;
  // Preserve the existing empty-allowlist platform-default convention. An explicit
  // nonempty tool policy must also authorize this connector's namespaced tool.
  return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(`connector_${id}`);
}

export function authorizedConnectors(store: AgentSqliteStore, owner: TaskOwner, employeeId?: string) {
  const experts = store.listLoadedExperts(owner.tenantId, owner.memberId).filter(e => !e.revoked && (!e.status || e.status === "active") && (!employeeId || e.employee_id === employeeId));
  const snapshots = store.listSnapshots(owner.tenantId, owner.memberId);
  return localConnectors(owner).flatMap(row => {
    const employees = experts.filter(e => snapshots.some(s => s.employee_id === e.employee_id && s.version === e.version && Array.isArray(s.connector_refs) && s.connector_refs.includes(row.connector_id) && permitsConnectorTool(s, row.connector_id))).map(e => e.employee_id);
    if (!employees.length) return [];
    return [{ connector_id: row.connector_id, display_name: row.display_name, type: "mcp" as const, status: (!row.token_env || process.env[row.token_env] ? "enabled" : "unavailable") as "enabled" | "unavailable", available_employee_ids: employees }];
  });
}

export function validateConnectorSelection(store: AgentSqliteStore, owner: TaskOwner, employeeId: string, ids: string[]): void {
  if (!ids.length) return;
  const available = authorizedConnectors(store, owner, employeeId);
  if (ids.some(id => !available.some(c => c.connector_id === id && c.status === "enabled"))) throw new AutomationError(422, "connector_unavailable", "A selected connector is not authorized or installed locally");
}

/** How to reach one MCP server. Credentials come from the process environment or the member's credential file, never the model. */
export interface McpTarget {
  url: string;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  timeoutMs?: number;
  /** Secret strings removed from any text handed back to the model. */
  secrets?: string[];
}

/** True when the server (or the OAuth layer) rejected the credential, so the member must sign in / renew the token. */
export function isMcpAuthFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof McpLoginRequiredError) return true;
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (candidate.name === "UnauthorizedError" || candidate.code === 401 || candidate.code === 403) return true;
    current = candidate.cause;
  }
  return false;
}

function transportFor(target: McpTarget, signal: AbortSignal): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { redirect: "error", signal, headers: target.headers ?? {} },
    ...(target.authProvider ? { authProvider: target.authProvider } : {}),
  });
}

function redact(text: string, secrets: string[] | undefined): string {
  return (secrets ?? []).filter(secret => secret.length >= 4).reduce((value, secret) => value.split(secret).join("[凭据已隐藏]"), text);
}

const CALL_FAILED = "连接器调用未能确认成功，请检查服务与审批记录；不要自动重试有副作用的操作。";

/** One MCP tool call over a fresh transport; any credential is redacted from the result. */
async function callMcpTool(config: McpTarget, input: { tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal, authFailureText?: string) {
  if (signal?.aborted) throw new Error("Connector call cancelled");
  const limit = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(limit);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const transport = transportFor(config, combined);
  const client = new Client({ name: "aiteam-connector", version: "1.0.0" });
  try {
    await client.connect(transport, { signal: combined });
    const inventory = await client.listTools({}, { signal: combined });
    if (!inventory.tools.some(tool => tool.name === input.tool)) throw new Error();
    const result = await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, { signal: combined, timeout: limit });
    const text = redact(JSON.stringify(result), config.secrets);
    return { content: [{ type: "text" as const, text: text.slice(0, 50_000) }], details: undefined, isError: Boolean(result.isError) };
  } catch (error) {
    return { content: [{ type: "text" as const, text: authFailureText && isMcpAuthFailure(error) ? authFailureText : CALL_FAILED }], details: undefined, isError: true };
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}

/** Lists the tools an MCP server really exposes; used to check an install request before it is stored. */
export async function listMcpTools(target: McpTarget | string, signal?: AbortSignal): Promise<string[]> {
  const config = typeof target === "string" ? { url: target } : target;
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const transport = transportFor(config, combined);
  const client = new Client({ name: "aiteam-connector", version: "1.0.0" });
  try {
    await client.connect(transport, { signal: combined });
    return (await client.listTools({}, { signal: combined })).tools.map(tool => tool.name);
  } finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}

/** Each call uses a fresh transport and current grants. Credentials never enter model-visible arguments. */
export function connectorTools(store: AgentSqliteStore, owner: TaskOwner, employeeId: string, conversationId: string, snapshot: FrozenSnapshot): ToolDefinition[] {
  const task = store.automation.forConversation(conversationId);
  const selected: string[] = task ? JSON.parse(task.connector_ids) : (Array.isArray(snapshot.connector_refs) ? snapshot.connector_refs as string[] : []);
  if (!selected.length) return [];
  if (task && selected.length) validateConnectorSelection(store, owner, employeeId, selected);
  return localConnectors(owner).filter(c => selected.includes(c.connector_id) && permitsConnectorTool(snapshot, c.connector_id) && (!c.token_env || process.env[c.token_env])).map(connector => ({
    name: `connector_${connector.connector_id}`,
    label: connector.display_name,
    description: `Call an authorized ${connector.display_name} tool. Allowed tools: ${connector.tools.join(", ")}. External actions require approval.`,
    parameters: Type.Object({ tool: Type.String({ enum: connector.tools }), arguments: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      validateConnectorSelection(store, owner, employeeId, [connector.connector_id]);
      const currentTask = store.automation.forConversation(conversationId);
      if (currentTask && !JSON.parse(currentTask.connector_ids).includes(connector.connector_id)) throw new Error("Connector authorization changed");
      const config = localConnectors(owner).find(c => c.connector_id === connector.connector_id);
      const input = params as { tool: string; arguments: Record<string, unknown> };
      if (!config || !config.tools.includes(input.tool) || !input.arguments || Array.isArray(input.arguments) || typeof input.arguments !== "object") throw new Error("Connector tool is not authorized");
      const token = config.token_env ? process.env[config.token_env] : undefined;
      return callMcpTool({ url: config.url, ...(token ? { headers: { Authorization: `Bearer ${token}` }, secrets: [token] } : {}) }, input, signal);
    },
  } as ToolDefinition));
}

const REF_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** The approval summary carries the full URL (and the replaced one), so its length is bounded to keep the record within its schema. */
const MAX_MCP_URL = 1024;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function validMcpUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash || url.search) throw new Error("invalid MCP url");
  return url;
}

/**
 * Personal MCP connectors the user approved in conversation. They are local to this member, carry no credentials,
 * never alter Manager configuration, and every call still goes through the external-tool approval gate.
 * An employee snapshot with an explicit tool allowlist can still exclude them (`connector_my_<ref>`).
 */
/**
 * The member's own MCP servers. They are the member's Agent capability, not the expert's (design 2026-11-17 §10):
 * the expert snapshot's tool allowlist covers enterprise-configured tools and does not filter these; every call is
 * still approval-gated as an external action.
 */
export function personalConnectorTools(store: AgentSqliteStore, owner: TaskOwner, auth?: McpRuntimeAuth): ToolDefinition[] {
  return store.listLocalCapabilities(owner.tenantId, owner.memberId).filter(item => item.kind === "mcp").map(item => ({
    name: `connector_my_${item.ref}`,
    label: item.display_name,
    description: `Call a tool of ${item.display_name}, an MCP server the user installed for themselves. Allowed tools: ${item.tools.join(", ")}. External actions require approval.`,
    parameters: Type.Object({ tool: Type.String({ enum: item.tools }), arguments: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const current = store.listLocalCapabilities(owner.tenantId, owner.memberId).find(row => row.kind === "mcp" && row.ref === item.ref);
      const input = params as { tool: string; arguments: Record<string, unknown> };
      if (!current || !current.tools.includes(input.tool) || !input.arguments || Array.isArray(input.arguments) || typeof input.arguments !== "object") throw new Error("Connector tool is not authorized");
      const target = installedMcpTarget(current, owner, auth);
      if (typeof target === "string") return fail(target);
      return callMcpTool(target, input, signal, signInAgainText(current));
    },
  } as ToolDefinition));
}

/** An enterprise-catalog skill the member may install for themselves (Manager `GET /grants/skills`). */
export interface InstallableSkillInfo {
  skill_id: string; display_name: string; version: string; content_hash: string; source_skill_id: string;
  /** platform: installed into the enterprise catalog from our platform skill market; enterprise: built by the enterprise. Older Managers omit it. */
  origin?: "platform" | "enterprise";
}
/** Manager-backed skill installation; absent when Manager or the personal skill cache is unavailable. */
export interface SkillInstaller {
  list(signal?: AbortSignal): Promise<InstallableSkillInfo[]>;
  /** Fetches the package signed for this member, verifies it and stores it in the personal skill cache. */
  install(skillId: string, signal?: AbortSignal): Promise<void>;
}
/** A platform MCP server the enterprise enabled (Manager `GET /grants/mcp-servers`, design §11.3 / MCP鉴权 §3.8). */
export interface InstallableMcpInfo {
  server_id: string; ref: string; display_name: string; summary: string; url: string; tools: string[]; revision: number;
  /** Older Managers omit these: such entries need no authentication. */
  auth?: LocalCapabilityAuth;
  auth_header?: string;
  oauth_scopes?: string;
  timeout_ms?: number;
  /** preregistered: the platform holds the provider-issued client id (and secret), fetched only to sign in / refresh. */
  oauth_client?: "preregistered" | "dynamic";
}
/** Manager-backed platform MCP catalog; absent without Manager. */
export interface McpCatalog {
  list(signal?: AbortSignal): Promise<InstallableMcpInfo[]>;
  /** Provider-issued OAuth client of a catalog entry; kept in memory only. */
  oauthClient?(serverId: string, signal?: AbortSignal): Promise<McpPreregisteredClient>;
}
/** Sign-in and credentials of personal MCP servers; absent in tests that need none. */
export interface McpRuntimeAuth {
  service?: McpAuthService;
  catalog?: McpCatalog;
  /** Override for tests; defaults to one unauthenticated initialize request. */
  probe?: (url: string, signal?: AbortSignal) => Promise<McpProbe>;
}

export const MIN_MCP_TIMEOUT_MS = 1_000;
export const MAX_MCP_TIMEOUT_MS = 300_000;
export function clampMcpTimeout(value: unknown, fallback = DEFAULT_MCP_TIMEOUT_MS): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(number, MIN_MCP_TIMEOUT_MS), MAX_MCP_TIMEOUT_MS);
}

function signInAgainText(item: Pick<LocalCapability, "display_name" | "ref" | "auth">): string {
  const name = item.display_name || item.ref;
  return item.auth === "bearer"
    ? `${name} 的访问令牌无效或已过期。请告诉用户到「设置 · 个人能力」更新令牌后再试；不要自动重试。`
    : `需要重新登录 ${name}。请告诉用户到「设置 · 个人能力」点「重新登录」，登录后再试；不要自动重试。`;
}

/** OAuth client for a catalog entry whose provider issued one by hand; read through Manager only when needed. */
function catalogClient(auth: McpRuntimeAuth | undefined, serverId: string): (() => Promise<McpPreregisteredClient | undefined>) | undefined {
  const catalog = auth?.catalog;
  if (!catalog?.oauthClient || !serverId) return undefined;
  return () => catalog.oauthClient!(serverId).catch(() => undefined);
}

/** Connection settings of an installed MCP; a string explains what the member has to do first. */
export function installedMcpTarget(item: LocalCapability, owner: TaskOwner, auth: McpRuntimeAuth | undefined): McpTarget | string {
  const base = { url: item.url, timeoutMs: item.timeout_ms || DEFAULT_MCP_TIMEOUT_MS };
  if (item.auth === "none" || !item.auth) return base;
  if (!auth?.service) return "本机暂时无法读取这个 MCP 的登录凭据，请稍后再试。";
  const stored = auth.service.credentials.get(owner, item.ref, item.url);
  if (item.auth === "bearer") {
    if (!stored?.token) return signInAgainText(item);
    const credential = { token: stored.token, header: stored.header ?? item.auth_header };
    return { ...base, headers: bearerHeaders(credential), secrets: [credential.token] };
  }
  if (!stored?.tokens?.access_token) return signInAgainText(item);
  const client = stored.catalog_client ? catalogClient(auth, stored.catalog_client) : undefined;
  return {
    ...base,
    authProvider: auth.service.provider(owner, item.ref, item.url, { ...(item.oauth_scope ? { scope: item.oauth_scope } : {}), ...(client ? { client } : {}) }),
    secrets: [stored.tokens.access_token, ...(stored.tokens.refresh_token ? [stored.tokens.refresh_token] : [])],
  };
}

export interface CapabilityInstallInput {
  kind: "mcp" | "skill";
  ref: string;
  display_name?: string;
  url?: string;
  reason?: string;
  /** Per tool call, ms (1 000–300 000); default 30 000 or the catalog's value. */
  timeout_ms?: number;
  /** Set only by the approval gate: the token the member typed into the approval dialog (bearer MCP); never from the model. */
  credential?: McpBearerCredential;
  /** Set only by the approval gate: lets the desktop follow this install's sign-in. */
  approvalId?: string;
  /** Set only by the approval gate from the user's decision; the model cannot pass it (schema forbids extra fields). */
  resolution?: CapabilityResolution | null;
  /** Set only by the approval gate: the record was approved by the member's auto-install grant, not a prompt. */
  autoApproved?: boolean;
  /** skill：来自企业外的来源（clawhub / url / text）。缺省走企业技能目录。MCP 用 url 即可，不用这个字段。 */
  source?: "clawhub" | "url" | "text";
  /** source=text：粘贴的 SKILL.md 全文。 */
  skill_md?: string;
  /** 包内某个技能根（相对包根，包根本身就是技能时为空串）。包里有多个技能又不指定时报错让用户选。 */
  root?: string;
  /** Set only by the approval gate: 批准时那份内容的内容哈希；执行时比对，避免批准后内容被换掉。 */
  approvedVersion?: string;
}
export type CapabilityInstallCheck =
  | {
    ok: true; summary: string; kind: "mcp" | "skill"; /** source is our platform catalog */ platform: boolean; /** an installed same-ref capability would be replaced */ replaces: boolean;
    /** The member still has to sign in / enter a token: auto-install may skip the approval, never this. */
    needsCredential: boolean;
  }
  | { ok: false; message: string };

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });
const INVALID_MCP = "安装未完成：标识或地址无效（地址须为 https 或本机地址，且不含账号、查询串）。请让用户检查。";

/**
 * 企业外来源的技能：ClawHub / 公开网址 / 粘贴的 SKILL.md。与桌面端「添加技能」共用同一套抓取与校验，
 * 只是这里是会话里员工判断后发起、装之前仍要成员批准。
 */
async function planExternalSkill(store: AgentSqliteStore, owner: TaskOwner, input: CapabilityInstallInput, custom: CustomSkillStore | undefined, signal?: AbortSignal): Promise<InstallPlan | string> {
  if (!custom) return "安装未完成：本机技能目录不可用，请重启桌面端后重试。";
  const source = input.source ?? "url";
  let files: { path: string; content: Buffer }[];
  let origin: CustomSkillPackage["origin"];
  if (source === "clawhub") {
    if (!input.url) return "安装未完成：没有填 ClawHub 地址。";
    const parts = clawHubParts(input.url);
    if (!parts) return "安装未完成：这不是 ClawHub 技能地址，形如 https://clawhub.ai/{作者}/skills/{标识}。";
    let handle = parts.owner;
    if (!handle) {
      const found = await clawHubCandidates(parts.slug, signal);
      if (found.length !== 1) return "安装未完成：ClawHub 上有多个同名技能，请让用户选一个具体地址（带作者）。";
      handle = found[0]!.owner;
    }
    const fetched = await fetchClawHubSkill(parts.slug, handle, signal);
    files = fetched.files;
    origin = { kind: "clawhub", label: "ClawHub", url: fetched.origin.url };
  } else if (source === "url") {
    if (!input.url) return "安装未完成：没有填技能网址。";
    const fetched = await fetchSkillFromUrl(input.url, signal);
    files = fetched.files;
    origin = { kind: "url", label: fetched.origin.label, url: fetched.origin.url };
  } else {
    if (!input.skill_md?.trim()) return "安装未完成：没有粘贴 SKILL.md 内容。";
    files = [{ path: "SKILL.md", content: Buffer.from(input.skill_md, "utf8") }];
    origin = { kind: "text", label: "粘贴" };
  }
  const roots = scanSkillRoots(files).filter((root) => isInstallableRoot(files, root));
  if (roots.length === 0) return "安装未完成：这个来源里找不到可安装的技能（每个技能要含 SKILL.md）。";
  const root = input.root !== undefined ? input.root : roots[0]!;
  if (!roots.includes(root)) return `安装未完成：指定的技能根不存在。这个包里可选：${roots.join("、") || "（包根）"}。`;
  if (roots.length > 1 && input.root === undefined) {
    const names = roots.map((item) => {
      try { return `${normalizeSkillAtRoot(files, item, origin).name}（${item || "包根"}）`; } catch { return item || "包根"; }
    });
    return `安装未完成：这个来源里有 ${roots.length} 个技能，请指定 root 选一个：${names.join("、")}。`;
  }
  let pkg: CustomSkillPackage;
  try { pkg = normalizeSkillAtRoot(files, root, origin); } catch (error) { return error instanceof Error && error.message ? `安装未完成：${error.message}` : "安装未完成：技能包校验失败。"; }
  const clash = store.listLocalCapabilities(owner.tenantId, owner.memberId)
    .find(item => item.kind === "skill" && item.ref === pkg.name && item.source !== "user_import" && item.source !== "clawhub_catalog");
  if (clash) return `安装未完成：已安装企业技能「${clash.display_name}」，同名外部技能无法安装；请让用户改 SKILL.md 里的 name。`;
  return {
    kind: "skill", ref: pkg.name, display_name: pkg.name, url: "", declaredTools: [], sourceRef: "",
    source: origin.kind === "clawhub" ? "clawhub_catalog" : "user_import",
    external: { pkg, version: skillContentHash(pkg), originLabel: origin.label, originUrl: origin.url ?? "" },
    reason: "",
    auth: "none", authHeader: "", scope: "", timeoutMs: DEFAULT_MCP_TIMEOUT_MS, preregistered: false,
  };
}

async function findSkill(skills: SkillInstaller | undefined, ref: string, signal?: AbortSignal): Promise<InstallableSkillInfo | string> {
  if (!skills) return "安装未完成：本机暂时无法从企业取技能（未连接企业服务）。";
  let items: InstallableSkillInfo[];
  try { items = await skills.list(signal); } catch { return "安装未完成：暂时无法读取企业技能目录，请稍后再试。"; }
  return items.find(item => item.skill_id === ref) ?? items.find(item => item.source_skill_id === ref)
    ?? `安装未完成：企业技能目录里没有可自行安装的技能「${ref}」。请告诉用户联系企业管理员把它安装到企业技能目录，并把可见范围设为全员。`;
}

/** What one `capability_install` request resolves to; computed the same way before the approval prompt and at execution. */
interface InstallPlan {
  kind: "mcp" | "skill";
  ref: string;
  display_name: string;
  source: LocalCapability["source"];
  /** MCP endpoint; empty for a skill. */
  url: string;
  /** Tool names the platform catalog declares (installed tools are the intersection); empty otherwise. */
  declaredTools: string[];
  /** Platform server id of a catalog MCP, platform skill id of a skill; empty otherwise. */
  sourceRef: string;
  skill?: InstallableSkillInfo;
  /** 企业外来源的技能包（ClawHub / 网址 / 粘贴）：内容与来源都在这里，装进本机自定义技能目录。 */
  external?: { pkg: CustomSkillPackage; version: string; originLabel: string; originUrl: string };
  existing?: LocalCapability;
  reason: string;
  /** MCP authentication; "none" for a skill. */
  auth: LocalCapabilityAuth;
  /** oauth: host of the provider's sign-in page. */
  authHost?: string;
  authHeader: string;
  scope: string;
  resourceMetadataUrl?: string;
  timeoutMs: number;
  /** Catalog entry whose provider issued the OAuth client by hand. */
  preregistered: boolean;
}

async function planInstall(store: AgentSqliteStore, owner: TaskOwner, input: CapabilityInstallInput, skills: SkillInstaller | undefined, mcps: McpCatalog | undefined, signal?: AbortSignal, auth?: McpRuntimeAuth, custom?: CustomSkillStore): Promise<InstallPlan | string> {
  const installed = store.listLocalCapabilities(owner.tenantId, owner.memberId);
  const reason = String(input.reason ?? "").slice(0, 200);
  if (input.kind === "skill" && input.source) {
    const external = await planExternalSkill(store, owner, input, custom, signal);
    if (typeof external === "string") return external;
    return { ...external, reason, existing: installed.find(item => item.kind === "skill" && item.ref === external.ref) };
  }
  if (input.kind === "skill") {
    const found = await findSkill(skills, String(input.ref ?? ""), signal);
    if (typeof found === "string") return found;
    const existing = installed.find(item => item.kind === "skill" && item.ref === found.skill_id);
    if (existing?.version === found.version) return `技能「${found.display_name || found.skill_id}」${found.version} 已安装，下一轮对话起可用，无需再装。`;
    return {
      kind: "skill", ref: found.skill_id, display_name: found.display_name.slice(0, 120), url: "", declaredTools: [],
      source: found.origin === "platform" ? "platform_catalog" : "enterprise_catalog", sourceRef: found.source_skill_id, skill: found, existing, reason,
      auth: "none", authHeader: "", scope: "", timeoutMs: DEFAULT_MCP_TIMEOUT_MS, preregistered: false,
    };
  }
  const ref = String(input.ref ?? "");
  if (!REF_RE.test(ref)) return INVALID_MCP;
  const existing = installed.find(item => item.kind === "mcp" && item.ref === ref);
  // The enterprise-enabled platform catalog wins: its address is used and a URL from the model is ignored.
  let entry: InstallableMcpInfo | undefined;
  let catalogDown = false;
  if (mcps) {
    try { entry = (await mcps.list(signal)).find(item => item.ref === ref); } catch { catalogDown = true; }
  }
  if (entry) {
    let url: URL;
    try { url = validMcpUrl(entry.url); } catch { return "安装未完成：企业 MCP 目录里该条目的地址无效，请告诉用户联系企业管理员。"; }
    return withMcpAuth({
      kind: "mcp", ref, display_name: entry.display_name.slice(0, 120), url: url.toString(), declaredTools: entry.tools,
      source: "platform_catalog", sourceRef: entry.server_id, existing, reason,
      auth: entry.auth ?? "none", authHeader: entry.auth_header ?? "", scope: entry.oauth_scopes ?? "",
      timeoutMs: clampMcpTimeout(input.timeout_ms ?? entry.timeout_ms), preregistered: entry.oauth_client === "preregistered",
    }, auth, signal);
  }
  if (!input.url) {
    return catalogDown
      ? "安装未完成：暂时无法读取企业 MCP 目录，请稍后再试；如果用户有该 MCP 的 https 地址，也可以带上地址再请求安装。"
      : `安装未完成：企业 MCP 目录里没有「${ref}」。如果用户有该 MCP 的 https 地址，请带上地址再请求安装；否则请告诉用户联系企业管理员在 MCP 市场启用。`;
  }
  let url: URL;
  try {
    if (String(input.url).length > MAX_MCP_URL) throw new Error("url too long");
    url = validMcpUrl(String(input.url));
  } catch {
    return INVALID_MCP;
  }
  return withMcpAuth({
    kind: "mcp", ref, display_name: String(input.display_name ?? "").slice(0, 120), url: url.toString(), declaredTools: [], source: "user_url", sourceRef: "", existing, reason,
    auth: "none", authHeader: "", scope: "", timeoutMs: clampMcpTimeout(input.timeout_ms), preregistered: false,
  }, auth, signal);
}

/**
 * Asks the server whether it needs authentication; the answer wins over what a catalog declares (the provider may have
 * changed). When it cannot be reached now, the declared mode stands and the install itself reports the failure.
 */
async function withMcpAuth(plan: InstallPlan, auth: McpRuntimeAuth | undefined, signal?: AbortSignal): Promise<InstallPlan> {
  let probe: McpProbe;
  try { probe = await (auth?.probe ?? probeMcpAuth)(plan.url, signal); } catch { return plan; }
  return {
    ...plan, auth: probe.auth,
    ...(probe.auth_host ? { authHost: probe.auth_host } : {}),
    ...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
    scope: plan.scope || probe.scope || "",
  };
}

function needsCredential(plan: InstallPlan, owner: TaskOwner, auth: McpRuntimeAuth | undefined): boolean {
  if (plan.kind !== "mcp" || plan.auth === "none") return false;
  const status = auth?.service?.status(owner, plan.ref, plan.url, plan.auth).auth_status;
  return status !== "signed_in" && status !== "token_set";
}

function summaryOf(plan: InstallPlan): string {
  const base = { kind: plan.kind, ref: plan.ref, display_name: plan.display_name, source: plan.source, reason: plan.reason };
  if (plan.kind === "skill") {
    if (plan.external) {
      return JSON.stringify({
        ...base, version: plan.external.version, source: plan.external.pkg.origin.kind === "clawhub" ? "clawhub_catalog" : "user_import",
        origin_label: plan.external.originLabel, ...(plan.external.originUrl ? { origin_url: plan.external.originUrl } : {}),
        ...(plan.existing ? { replaces: { display_name: plan.existing.display_name, version: plan.existing.version } } : {}),
      });
    }
    return JSON.stringify({ ...base, version: plan.skill!.version, ...(plan.existing ? { replaces: { display_name: plan.existing.display_name, version: plan.existing.version } } : {}) });
  }
  return JSON.stringify({
    ...base, url: plan.url, auth: plan.auth,
    ...(plan.authHost ? { auth_host: plan.authHost } : {}),
    ...(plan.auth === "bearer" && plan.authHeader ? { auth_header: plan.authHeader } : {}),
    ...(plan.existing ? { replaces: { display_name: plan.existing.display_name, url: plan.existing.url } } : {}),
  });
}

/** 批准摘要里外部技能的内容哈希（`capability_install:` 之后的 JSON）；其它情况为空。 */
export function approvedSkillVersion(summary: string): string | undefined {
  const prefix = "capability_install:";
  if (!summary.startsWith(prefix)) return undefined;
  try {
    const data = JSON.parse(summary.slice(prefix.length).trim()) as { kind?: unknown; origin_label?: unknown; version?: unknown };
    // 只对「带来源的外部技能」做哈希校验；企业目录技能没有 origin_label。
    return data.kind === "skill" && typeof data.origin_label === "string" && typeof data.version === "string" ? data.version : undefined;
  } catch { return undefined; }
}

/**
 * Runs before the approval prompt. Requests that can never succeed (bad ref/URL, skill not in the enterprise catalog,
 * the same skill version already installed) are bounced back to the model without bothering the user. A same-ref clash
 * is NOT bounced: the user decides in the approval dialog (replace / rename / cancel), so the summary names what would
 * be replaced. The summary is stored in the approval record and holds nothing the install itself does not accept;
 * its `source` tells the dialog whether «以后直接安装» may be offered (platform catalog only).
 */
export async function checkCapabilityInstall(store: AgentSqliteStore, owner: TaskOwner, params: unknown, skills?: SkillInstaller, signal?: AbortSignal, mcps?: McpCatalog, auth?: McpRuntimeAuth, custom?: CustomSkillStore): Promise<CapabilityInstallCheck> {
  const plan = await planInstall(store, owner, params as CapabilityInstallInput, skills, mcps, signal, auth, custom);
  if (typeof plan === "string") return { ok: false, message: plan };
  return { ok: true, summary: summaryOf(plan), kind: plan.kind, platform: plan.source === "platform_catalog", replaces: Boolean(plan.existing), needsCredential: needsCredential(plan, owner, auth) };
}

function loginFailureText(error: unknown, name: string): string {
  const reason = error instanceof McpLoginError ? error.reason : "failed";
  if (reason === "timeout") return `安装未完成：用户没有在 10 分钟内完成 ${name} 的登录。可以稍后再请求安装。`;
  if (reason === "cancelled") return `安装未完成：用户取消了 ${name} 的登录。`;
  if (reason === "denied") return `安装未完成：用户在服务方页面拒绝了 ${name} 的授权。`;
  return `安装未完成：${name} 的登录没有成功（服务方不支持自动注册时，需要用户在「设置 · 个人能力 · 添加 MCP」的高级选项里填写应用编号，或改用访问令牌）。`;
}

interface ConnectResult { target: McpTarget; tools: string[]; credential?: McpBearerCredential }

/**
 * Obtains the member's credential (sign-in or the given token), then reads the real tool list with it.
 * Returns a message for the model / desktop when the member still has to act or the server failed.
 */
async function connectForInstall(plan: InstallPlan, ref: string, owner: TaskOwner, auth: McpRuntimeAuth | undefined, options: {
  credential?: McpBearerCredential; approvalId?: string; client?: McpPreregisteredClient; signal?: AbortSignal;
}): Promise<ConnectResult | string> {
  const name = plan.display_name || ref;
  const base: McpTarget = { url: plan.url, timeoutMs: plan.timeoutMs };
  let target: McpTarget = base;
  let credential: McpBearerCredential | undefined;
  if (plan.auth !== "none" && !auth?.service) return "安装未完成：本机暂时无法保存这个 MCP 的登录凭据，请稍后再试。";
  if (plan.auth === "bearer") {
    const stored = auth!.service!.credentials.get(owner, ref, plan.url);
    credential = options.credential?.token ? { token: options.credential.token, header: options.credential.header || plan.authHeader } : stored?.token ? { token: stored.token, header: stored.header ?? plan.authHeader } : undefined;
    if (!credential) return `安装未完成：${name} 需要访问令牌，用户没有填写。请告诉用户在审批弹窗或「设置 · 个人能力 · 添加 MCP」里填写服务方发的令牌。`;
    if (!validBearerHeader(credential.header)) return "安装未完成：令牌请求头名无效。";
    target = { ...base, headers: bearerHeaders(credential), secrets: [credential.token] };
  } else if (plan.auth === "oauth") {
    const service = auth!.service!;
    const fixed = options.client ? async () => options.client : plan.preregistered ? catalogClient(auth, plan.sourceRef) : undefined;
    try {
      const { done } = await service.login(owner, ref, plan.url, {
        ...(plan.scope ? { scope: plan.scope } : {}),
        ...(plan.resourceMetadataUrl ? { resourceMetadataUrl: plan.resourceMetadataUrl } : {}),
        ...(fixed ? { client: fixed } : {}),
        ...(options.client ? { preregistered: options.client } : {}),
        ...(plan.preregistered && !options.client ? { catalogClient: plan.sourceRef } : {}),
        ...(options.approvalId ? { approvalId: options.approvalId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await done;
    } catch (error) {
      return loginFailureText(error, name);
    }
    target = { ...base, authProvider: service.provider(owner, ref, plan.url, { ...(plan.scope ? { scope: plan.scope } : {}), ...(fixed ? { client: fixed } : {}) }) };
  }
  try {
    const advertised = (await listMcpTools(target, options.signal)).filter(tool => TOOL_RE.test(tool)).slice(0, 50);
    // An OAuth catalog entry may leave its tools empty: the server's real list after sign-in counts (design §8 #4).
    const tools = plan.source === "platform_catalog" && plan.declaredTools.length ? advertised.filter(tool => plan.declaredTools.includes(tool)) : advertised;
    if (!tools.length) throw new Error("no tools");
    return { target, tools, ...(credential ? { credential } : {}) };
  } catch (error) {
    if (plan.auth === "bearer" && isMcpAuthFailure(error)) return `安装未完成：服务方拒绝了 ${name} 的访问令牌（令牌无效或已过期）。请让用户检查令牌。`;
    return plan.source === "platform_catalog"
      ? "安装未完成：企业 MCP 目录里的这个服务暂时无法连接，或没有目录声明的工具。请稍后再试或告诉用户联系企业管理员。"
      : "安装未完成：地址无效、服务无法连接或没有可用工具。请让用户检查地址。";
  }
}

function storeMcp(store: AgentSqliteStore, owner: TaskOwner, auth: McpRuntimeAuth | undefined, plan: InstallPlan, ref: string, connected: ConnectResult, approvedBy: string): LocalCapability {
  if (connected.credential) auth!.service!.credentials.put(owner, ref, { url: plan.url, auth: "bearer", token: connected.credential.token, ...(connected.credential.header ? { header: connected.credential.header } : {}) });
  const name = (plan.display_name || ref).slice(0, 120);
  store.putLocalCapability(owner.tenantId, owner.memberId, {
    kind: "mcp", ref, display_name: name, url: plan.url, tools: connected.tools, source_ref: plan.sourceRef,
    source: plan.source, reason: plan.reason, approved_by: approvedBy,
    auth: plan.auth, auth_header: connected.credential?.header ?? (plan.auth === "bearer" ? plan.authHeader : ""), oauth_scope: plan.auth === "oauth" ? plan.scope : "", timeout_ms: plan.timeoutMs,
  });
  return store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.kind === "mcp" && item.ref === ref)!;
}

/** A failed install must not leave a credential behind for a ref that is not installed. */
function dropOrphanCredential(store: AgentSqliteStore, owner: TaskOwner, auth: McpRuntimeAuth | undefined, ref: string): void {
  if (!auth?.service || store.listLocalCapabilities(owner.tenantId, owner.memberId).some(item => item.kind === "mcp" && item.ref === ref)) return;
  auth.service.credentials.delete(owner, ref);
}

export class McpInstallError extends Error {
  constructor(readonly code: "invalid_mcp" | "mcp_exists" | "mcp_install_failed", message: string) { super(message); this.name = "McpInstallError"; }
}

/** What the desktop «添加 MCP» window sends; the token and client go straight from the desktop to this Agent. */
export interface DirectMcpInstall {
  ref: string; display_name?: string; url: string; timeout_ms?: number; reason?: string; replace?: boolean;
  credential?: McpBearerCredential; oauth_client?: McpPreregisteredClient;
}

/**
 * The member adds an MCP themselves (no model involved). Returns the installed capability, or a pending sign-in whose
 * completion finishes the install. A hand-entered OAuth client is kept with the member's credential.
 */
export async function installMcpDirectly(store: AgentSqliteStore, owner: TaskOwner, auth: McpRuntimeAuth, request: DirectMcpInstall, signal?: AbortSignal): Promise<{ capability?: LocalCapability; login?: McpLogin }> {
  const ref = String(request.ref ?? "");
  if (!REF_RE.test(ref)) throw new McpInstallError("invalid_mcp", "标识无效：小写字母开头，只含小写字母、数字、- 或 _。");
  let url: URL;
  try {
    if (String(request.url ?? "").length > MAX_MCP_URL) throw new Error("too long");
    url = validMcpUrl(String(request.url));
  } catch { throw new McpInstallError("invalid_mcp", "地址无效：须为 https（或本机地址），不含账号、查询串。"); }
  const existing = store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.kind === "mcp" && item.ref === ref);
  if (existing && !request.replace) throw new McpInstallError("mcp_exists", `「${ref}」已经装好了，无需重复添加；需要换成这次填的配置才点替换。`);
  const plan = await withMcpAuth({
    kind: "mcp", ref, display_name: String(request.display_name ?? "").slice(0, 120), url: url.toString(), declaredTools: [], source: "user_url", sourceRef: "",
    ...(existing ? { existing } : {}), reason: String(request.reason ?? "").slice(0, 200),
    auth: "none", authHeader: request.credential?.header ?? "", scope: "", timeoutMs: clampMcpTimeout(request.timeout_ms), preregistered: false,
  }, auth, signal);
  if (plan.auth === "bearer" && !request.credential?.token && !auth.service?.credentials.get(owner, ref, plan.url)?.token) {
    throw new McpInstallError("mcp_install_failed", "这个 MCP 需要访问令牌，请填写服务方发的令牌。");
  }
  const client = request.oauth_client?.client_id ? request.oauth_client : undefined;
  if (plan.auth !== "oauth") {
    const connected = await connectForInstall(plan, ref, owner, auth, { ...(request.credential ? { credential: request.credential } : {}), ...(signal ? { signal } : {}) });
    if (typeof connected === "string") throw new McpInstallError("mcp_install_failed", connected);
    return { capability: storeMcp(store, owner, auth, plan, ref, connected, owner.memberId) };
  }
  if (!auth.service) throw new McpInstallError("mcp_install_failed", "本机暂时无法保存这个 MCP 的登录凭据，请稍后再试。");
  const service = auth.service;
  const fixed = client ? async () => client : undefined;
  const finish = async () => {
    const target: McpTarget = { url: plan.url, timeoutMs: plan.timeoutMs, authProvider: service.provider(owner, ref, plan.url, { ...(plan.scope ? { scope: plan.scope } : {}), ...(fixed ? { client: fixed } : {}) }) };
    try {
      const tools = (await listMcpTools(target)).filter(tool => TOOL_RE.test(tool)).slice(0, 50);
      if (!tools.length) throw new Error("no tools");
      storeMcp(store, owner, auth, plan, ref, { target, tools }, owner.memberId);
    } catch (error) {
      dropOrphanCredential(store, owner, auth, ref);
      throw new McpLoginError("failed", error instanceof Error ? error.message : "install failed");
    }
  };
  try {
    const { login } = await service.login(owner, ref, plan.url, {
      ...(plan.scope ? { scope: plan.scope } : {}),
      ...(plan.resourceMetadataUrl ? { resourceMetadataUrl: plan.resourceMetadataUrl } : {}),
      ...(fixed ? { client: fixed, preregistered: client } : {}),
      onDone: finish,
    });
    if (login) return { login };
  } catch (error) {
    dropOrphanCredential(store, owner, auth, ref);
    throw new McpInstallError("mcp_install_failed", loginFailureText(error, plan.display_name || ref));
  }
  return { capability: store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.kind === "mcp" && item.ref === ref) };
}

/**
 * The model may only *ask* to install: this tool is unknown to the approval classifier, so it needs a human decision,
 * or the member's own auto-install grant for this kind from our platform catalog (design §11.3). A clash with an
 * installed capability is resolved by the user in the approval dialog (replace / rename for MCP / cancel); without that
 * choice nothing is overwritten. MCP: the server is contacted and its real tool list stored (for a catalog entry, only
 * tools the catalog declares); no credentials pass through the model. Skill: the package signed for this member is
 * verified before it is stored.
 */
export function capabilityInstallTool(store: AgentSqliteStore, owner: TaskOwner, skills?: SkillInstaller, mcps?: McpCatalog, auth?: McpRuntimeAuth, custom?: CustomSkillStore): ToolDefinition {
  return {
    name: "capability_install",
    label: "Install capability",
    description: "Ask the user to install a capability for themselves. Call it only when the task truly needs one you do not have. "
      + "kind=skill: ref is a skill id from the enterprise skill catalog or the solution's recommended skills; "
      + "to install a skill from somewhere else, set source to clawhub / url / text (url is the public https address, text carries the pasted SKILL.md in skill_md). "
      + "kind=mcp: ref may be the id of an MCP the enterprise enabled from the platform catalog (no url needed; the catalog address is used); "
      + "otherwise give an https (or localhost) url the user gave you or the solution recommended; never invent URLs. "
      + "A package that holds several skills needs `root` to name which one; ask the user which when you cannot tell. "
      + "If the server needs sign-in or a token, the user does that themselves outside the conversation: never ask for, accept or pass tokens. "
      + "The user must approve (and decides about replacing an installed one); do not retry after a denial.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("mcp"), Type.Literal("skill")]),
      ref: Type.String({ description: "mcp: short id (lowercase letters, digits, - or _); skill: the skill name from its SKILL.md frontmatter" }),
      display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "mcp only; a skill takes its name from the package" })),
      url: Type.Optional(Type.String({ description: "mcp: endpoint (streamable HTTP). skill: source=url / source=clawhub 时的公开地址" })),
      reason: Type.String({ maxLength: 200, description: "why the task needs it" }),
      timeout_ms: Type.Optional(Type.Integer({ minimum: MIN_MCP_TIMEOUT_MS, maximum: MAX_MCP_TIMEOUT_MS, description: "mcp: per tool call timeout in ms when the user's config gives one" })),
      source: Type.Optional(Type.Union([Type.Literal("clawhub"), Type.Literal("url"), Type.Literal("text")], { description: "skill：企业外来源。缺省 = 企业技能目录。" })),
      skill_md: Type.Optional(Type.String({ maxLength: 200_000, description: "source=text：SKILL.md 全文。" })),
      root: Type.Optional(Type.String({ description: "包里指定技能根（相对包根）；包里有多个技能时必须指定。" })),
    }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const input = params as CapabilityInstallInput;
      const resolution = input.resolution ?? undefined;
      // Re-planned here as well: the approval may have waited while another install or the catalogs changed.
      const plan = await planInstall(store, owner, input, skills, mcps, signal, auth, custom);
      if (typeof plan === "string") return fail(plan);
      // Auto-approval covered only a platform-catalog install that replaced nothing and needed no sign-in; anything else needs the user again.
      if (input.autoApproved && (plan.source !== "platform_catalog" || plan.existing || needsCredential(plan, owner, auth))) {
        return fail("安装未完成：能力目录或本机已装能力在批准后发生了变化，请重新发起安装请求。");
      }
      const approvedBy = input.autoApproved ? AUTO_INSTALL_APPROVER : owner.memberId;
      if (plan.kind === "skill") {
        if (plan.external) {
          // 企业外来源（ClawHub / 网址 / 粘贴）：装进本机自定义技能目录，不经企业签名缓存。
          if (!custom) return fail("安装未完成：本机技能目录不可用，请重启桌面端后重试。");
          if (resolution?.action === "rename") return fail("技能不能改名安装；用户可以选择覆盖或取消。");
          if (plan.existing && resolution?.action !== "replace") return fail(`已装有「${plan.existing.display_name}」，用户没有选择覆盖，未安装。`);
          // 批准后内容可能已被换掉：摘要里的哈希与这次下载的必须一致。
          if (input.approvedVersion && input.approvedVersion !== plan.external.version) {
            return fail("安装未完成：这个技能的内容在你批准之后发生了变化，请重新发起安装请求。");
          }
          try {
            const capability = installOneCustomSkill(store, custom, owner, plan.external.pkg, resolution?.action === "replace");
            return { content: [{ type: "text" as const, text: `已安装技能「${capability.display_name}」${capability.version}，下一轮对话起可用。` }], details: undefined };
          } catch (error) {
            return fail(error instanceof Error && error.message ? error.message : "安装未完成：技能包装不进本机目录。");
          }
        }
        const found = plan.skill!;
        if (resolution?.action === "rename") return fail("技能不能改名安装；用户可以选择覆盖或取消。");
        if (plan.existing && resolution?.action !== "replace") return fail("已装有该技能的其他版本，用户没有选择覆盖，未安装。");
        const outcome = await installPlannedSkill(store, owner, plan, skills!, approvedBy, signal);
        if ("error" in outcome) return fail(outcome.text);
        return { content: [{ type: "text" as const, text: `已安装技能「${found.display_name || found.skill_id}」${found.version}，下一轮对话起可用。` }], details: undefined };
      }
      const ref = resolution?.action === "rename" ? resolution.ref : plan.ref;
      if (!REF_RE.test(ref)) return fail("安装未完成：新标识无效。");
      const installed = store.listLocalCapabilities(owner.tenantId, owner.memberId);
      if (installed.some(item => item.kind === "mcp" && item.ref === ref) && resolution?.action !== "replace") {
        return fail(resolution?.action === "rename"
          ? `安装未完成：新标识 ${ref} 也已被占用。请让用户换一个。`
          : `已安装同名能力 ${ref}，用户没有选择覆盖或改名，未安装。`);
      }
      const connected = await connectForInstall(plan, ref, owner, auth, {
        ...(input.credential ? { credential: input.credential } : {}),
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        ...(signal ? { signal } : {}),
      });
      if (typeof connected === "string") {
        dropOrphanCredential(store, owner, auth, ref);
        return fail(connected);
      }
      const saved = storeMcp(store, owner, auth, plan, ref, connected, approvedBy);
      const signedIn = plan.auth === "oauth" ? "（已登录服务方账号）" : plan.auth === "bearer" ? "（已保存访问令牌）" : "";
      return { content: [{ type: "text" as const, text: `已安装 ${saved.display_name}（标识 ${ref}）${signedIn}，可用工具：${connected.tools.join(", ")}。下一轮对话起可调用。` }], details: undefined };
    },
  } as ToolDefinition;
}

/**
 * 找技能：企业目录里没有时，让员工自己去外面找。ClawHub 用关键词搜索；GitHub 找像技能集的仓库。
 * 只返回候选清单，不装——装仍然走 capability_install 并经成员批准。
 */
export function capabilitySearchTool(store: AgentSqliteStore, owner: TaskOwner, skills?: SkillInstaller, mcps?: McpCatalog, options: { signal?: AbortSignal } = {}): ToolDefinition {
  return {
    name: "capability_search",
    label: "Search capabilities",
    description: "Find a capability the member needs, in two steps. "
      + "Step 1: look in the enterprise catalog (installable skills and enabled MCP servers) and report what matches. "
      + "Step 2: only if the enterprise has nothing suitable, search outside — ClawHub (clawhub.ai) and GitHub — and report those candidates. "
      + "Return a short ranked list with each candidate's address. Never install anything here; the install goes through capability_install and needs the member's approval.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 120, description: "what the member needs, in a few words (Chinese or English)" }),
    }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const { query } = params as { query: string };
      const keyword = query.trim().toLowerCase();
      const scope = signal ?? options.signal;
      // 第一步：企业自己的目录。命中就只用它的结果，不再往外搜。
      const sections: string[] = [];
      try {
        const catalog = (await skills?.list(scope)) ?? [];
        const inEnterprise = catalog.filter((item) => `${item.display_name} ${item.skill_id}`.toLowerCase().includes(keyword)).slice(0, 5);
        if (inEnterprise.length) sections.push(`企业技能目录（可直接装）：\n${inEnterprise.map((item) => `- ${item.display_name}（${item.skill_id}）`).join("\n")}`);
      } catch { /* 目录读不到就跳过，不阻断外面的搜索 */ }
      try {
        const servers = (await mcps?.list(scope)) ?? [];
        const inMcp = servers.filter((item) => `${item.display_name} ${item.ref} ${item.summary}`.toLowerCase().includes(keyword)).slice(0, 5);
        if (inMcp.length) sections.push(`企业 MCP 目录（可直接装）：\n${inMcp.map((item) => `- ${item.display_name}（${item.ref}）`).join("\n")}`);
      } catch { /* 同上 */ }
      if (sections.length) {
        return { content: [{ type: "text" as const, text: `${sections.join("\n\n")}\n\n企业目录里已有，直接用它，不用往外找。` }], details: undefined };
      }
      // 第二步：企业没有，才搜外面。
      const results = await Promise.allSettled([searchClawHubSkills(query, 10, scope), searchGithubSkills(query, 10, scope)]);
      const hits = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (!hits.length) return { content: [{ type: "text" as const, text: `企业目录和外面（ClawHub / GitHub）都没找到和「${query}」相关的能力。换个说法再搜，或告诉用户需要他提供地址。` }], details: undefined };
      const lines = hits.slice(0, 10).map((hit) => `${hit.source === "clawhub" ? "ClawHub" : "GitHub"} ${hit.name}${hit.downloads === null ? "" : `（${hit.downloads}）`}${hit.description ? `：${hit.description.slice(0, 120)}` : ""}\n  ${hit.url}`);
      return { content: [{ type: "text" as const, text: `企业目录里没有，外面找到这些候选（装哪个由你判断，装前要成员批准）：\n${lines.join("\n")}` }], details: undefined };
    },
  } as ToolDefinition;
}

/** Fetches, verifies and records a planned skill; shared by the approved chat install and the desktop «添加技能». */
async function installPlannedSkill(store: AgentSqliteStore, owner: TaskOwner, plan: InstallPlan, skills: SkillInstaller, approvedBy: string, signal?: AbortSignal): Promise<{ capability: LocalCapability } | { error: "unavailable" | "signature"; text: string }> {
  const found = plan.skill!;
  try {
    await skills.install(found.skill_id, signal);
  } catch (error) {
    if (!(error instanceof SkillVerificationError)) return { error: "unavailable", text: "安装未完成：企业服务暂不可用，请稍后再试。" };
    // 签名校验不过（通常是企业更换或吊销了签名密钥）：不可以安装；已装的版本不动，照常可用。
    const kept = plan.existing;
    return {
      error: "signature",
      text: kept
        ? `不可以安装：「${found.display_name || found.skill_id}」${found.version} 的技能包签名校验未通过（企业可能更换了签名密钥）。本机已装的 ${kept.version ?? ""} 版不受影响，仍可继续使用。`
        : `不可以安装：「${found.display_name || found.skill_id}」的技能包签名校验未通过（企业可能更换了签名密钥）。请告诉用户联系企业管理员。`,
    };
  }
  store.putLocalCapability(owner.tenantId, owner.memberId, {
    kind: "skill", ref: found.skill_id, display_name: found.display_name || found.skill_id, url: "", tools: [], version: found.version, source_ref: plan.sourceRef,
    source: plan.source, reason: plan.reason, approved_by: approvedBy,
  });
  return { capability: store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.kind === "skill" && item.ref === found.skill_id)! };
}

export class SkillInstallError extends Error {
  constructor(readonly code: "skill_not_installable" | "skill_installed" | "skill_exists" | "skill_install_failed" | "skill_signature_invalid" | "manager_unavailable", message: string) { super(message); this.name = "SkillInstallError"; }
}

const SOURCE_LABELS: Record<CustomSkillPackage["origin"]["kind"], string> = { folder: "自定义", zip: "自定义", file: "自定义", text: "自定义", url: "网址", clawhub: "ClawHub" };

/** 这个根下的技能能不能装；与 preview 用同一套校验，避免预览说不行、安装却去试。 */
function isInstallableRoot(files: { path: string; content: Buffer }[], root: string): boolean {
  try {
    normalizeSkillAtRoot(files, root, { kind: "folder", label: "" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Desktop «能力» page: the member imports their own skill (folder / zip / single .md / pasted SKILL.md / https URL).
 * Unsigned, so it is stored in a separate local store with a per-file hash instead of the signed SkillCache.
 * `preview` only validates and reports; otherwise it installs, refusing to shadow an enterprise skill.
 */
export interface CustomSkillScanItem {
  /** 包内根路径（相对包根）；包根本身就是技能时为 ""。 */
  root: string;
  name: string;
  description: string;
  file_count: number;
  total_bytes: number;
  /** 校验不通过时为 false，reason 给具体中文原因；这种不会被安装。 */
  ok: boolean;
  reason?: string;
}

/** 失败原因里带出的技能名（「X」已经装好了…）。 */
function installedNameFromReason(reason: string): string {
  const match = /^「([^」]+)」/.exec(reason);
  return match?.[1] ?? "";
}

export interface CustomSkillClawHubPreview {
  /** 同名多作者时给界面挑；只有一个或已确定作者时为 null。 */
  candidates: CustomSkillClawHubCandidate[] | null;
  /** ClawHub 的安全扫描结论；拿不到时为 null。 */
  security: CustomSkillClawHubSecurity | null;
  /** 被跳过的平台专用文件（OpenClaw 钩子），仅说明用。 */
  skipped: string[];
}

export async function importCustomSkill(
  store: AgentSqliteStore, custom: CustomSkillStore, owner: TaskOwner,
  request: { source: "folder" | "zip" | "file" | "text" | "url" | "clawhub"; path?: string; skill_md?: string; url?: string; preview?: boolean; replace?: boolean; roots?: readonly string[] },
  signal?: AbortSignal,
): Promise<{ preview?: CustomSkillPreview; capability?: LocalCapability; scan?: CustomSkillScanItem[]; results?: CustomSkillInstallResultItem[]; clawhub?: CustomSkillClawHubPreview }> {
  const origin = { kind: request.source, label: request.source === "clawhub" ? "ClawHub" : (SOURCE_LABELS[request.source] || ""), ...(request.url?.trim() ? { url: request.url.trim() } : {}) } as CustomSkillPackage["origin"];
  let files: { path: string; content: Buffer }[];
  let clawHub: CustomSkillClawHubPreview | undefined;
  if (request.source === "clawhub") {
    if (!request.url) throw new CustomSkillError("invalid_skill_package", "没有填 ClawHub 地址。");
    const parts = clawHubParts(request.url);
    if (!parts) throw new CustomSkillError("invalid_skill_package", "这不是 ClawHub 技能地址，形如 https://clawhub.ai/{作者}/skills/{标识}。");
    let handle = parts.owner;
    if (!handle) {
      const found = await clawHubCandidates(parts.slug, signal);
      if (found.length === 1) handle = found[0]!.owner;
      // 多个同名技能：不猜，把候选交给界面让用户选（选中后用带作者的地址再来一次）。
      else return { clawhub: { candidates: found, security: null, skipped: [] } };
    }
    const fetched = await fetchClawHubSkill(parts.slug, handle, signal);
    files = fetched.files;
    origin.kind = "clawhub"; origin.label = "ClawHub"; origin.url = fetched.origin.url;
    clawHub = { candidates: null, security: await clawHubSecurity(parts.slug, handle, signal), skipped: fetched.skipped };
  } else if (request.source === "folder") {
    if (!request.path) throw new CustomSkillError("invalid_skill_package", "没有选择文件夹。");
    files = await readSkillFolder(request.path);
  } else if (request.source === "file") {
    if (!request.path) throw new CustomSkillError("invalid_skill_package", "没有选择 .md 文件。");
    files = await readSkillFile(request.path);
  } else if (request.source === "zip") {
    if (!request.path) throw new CustomSkillError("invalid_skill_package", "没有选择 zip。");
    files = unzipEntries(await readFileAsync(toLocalPath(request.path)));
  } else if (request.source === "text") {
    if (!request.skill_md) throw new CustomSkillError("invalid_skill_package", "没有粘贴 SKILL.md 内容。");
    files = [{ path: "SKILL.md", content: Buffer.from(request.skill_md, "utf8") }];
  } else {
    if (!request.url) throw new CustomSkillError("invalid_skill_package", "没有填网址。");
    const fetched = await fetchSkillFromUrl(request.url, signal);
    files = fetched.files; origin.kind = "url"; origin.label = fetched.origin.label; origin.url = fetched.origin.url;
  }
  const safe = files.map((file) => ({ path: file.path, content: file.content }));
  // 一个文件夹 / 压缩包里可能有多个技能：先扫描出所有含 SKILL.md 的目录。
  const roots = request.roots?.length ? request.roots : scanSkillRoots(safe);
  if (roots.length === 0) {
    throw new CustomSkillError("invalid_skill_package", "这个包里找不到任何 SKILL.md。");
  }
  if (request.preview) {
    const items: CustomSkillScanItem[] = roots.map((root) => {
      try {
        const pkg = normalizeSkillAtRoot(safe, root, origin);
        return { root, name: pkg.name, description: pkg.description, file_count: pkg.files.length, total_bytes: pkg.files.reduce((sum, file) => sum + file.content.length, 0), ok: true };
      } catch (error) {
        // 一个技能不合规不该让整个包扫不出来：标出来，用户只装能用的。
        const reason = error instanceof Error && error.message ? error.message : "技能包校验失败。";
        const files = safe.filter((file) => root && file.path.startsWith(root + "/"));
        return { root, name: "", description: "", file_count: files.length, total_bytes: files.reduce((sum, file) => sum + file.content.length, 0), ok: false, reason };
      }
    });
    // 只有一个技能时保持原来的单技能预览，界面不必改。
    if (items.length === 1) {
      const pkg = normalizeSkillAtRoot(safe, roots[0]!, origin);
      return { preview: { name: pkg.name, description: pkg.description, file_count: pkg.files.length, total_bytes: pkg.files.reduce((sum, file) => sum + file.content.length, 0), files: pkg.files.slice(0, 20).map((file) => file.path), origin_label: pkg.origin.label }, ...(clawHub ? { clawhub: clawHub } : {}) };
    }
    return { scan: items, ...(clawHub ? { clawhub: clawHub } : {}) };
  }
  // 不指定 roots 时装所有校验通过的（校验不过的装了也只会失败，不如不进安装清单）。
  const chosen = request.roots?.length ? request.roots : roots.filter((root) => isInstallableRoot(safe, root));
  if (chosen.length === 0) throw new CustomSkillError("invalid_skill_package", "这个包里没有可安装的技能。");
  // 批量：一次装多个。逐个装，某个失败不影响其余；失败的在结果里给出原因。
  if (chosen.length > 1) {
    const results: CustomSkillInstallResultItem[] = [];
    for (const root of chosen) {
      // 先规范化一次：成功则用它安装，失败则如实报原因，并且仍然带上拿到的名字
      //（重复时界面要显示技能名，不能只给包内路径）。
      try {
        const pkg = normalizeSkillAtRoot(safe, root, origin);
        const capability = installOneCustomSkill(store, custom, owner, pkg, request.replace === true);
        results.push({ root, name: capability.ref, ok: true });
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : "安装失败。";
        const name = installedNameFromReason(reason);
        results.push({ root, name, ok: false, reason });
      }
    }
    return { results };
  }
  const root = chosen[0]!;
  const pkg = normalizeSkillAtRoot(safe, root, origin);
  const capability = installOneCustomSkill(store, custom, owner, pkg, request.replace === true);
  return { capability };
}

export interface CustomSkillInstallResultItem {
  root: string;
  name: string;
  ok: boolean;
  reason?: string;
}

/** 装一个技能：与企业技能同名拒绝；同名自定义技能须 replace。 */
function installOneCustomSkill(
  store: AgentSqliteStore, custom: CustomSkillStore, owner: TaskOwner,
  pkg: CustomSkillPackage, replace: boolean,
): LocalCapability {
  const existing = store.listLocalCapabilities(owner.tenantId, owner.memberId).filter((item) => item.kind === "skill" && item.ref === pkg.name);
  if (existing.some((item) => item.source !== "user_import" && item.source !== "clawhub_catalog")) {
    throw new CustomSkillError("invalid_skill_package", `已安装企业技能「${existing[0]!.display_name}」，同名自定义技能无法安装；请改 SKILL.md 里的 name。`);
  }
  if (existing.length > 0 && !replace) {
    throw new SkillInstallError("skill_exists", `「${existing[0]!.display_name}」已经装好了（${existing[0]!.version} 版），现在就能用；需要换成这次选的内容才点替换安装。`);
  }
  const record = custom.install({ tenantId: owner.tenantId, memberId: owner.memberId }, pkg);
  store.putLocalCapability(owner.tenantId, owner.memberId, {
    kind: "skill", ref: record.name, display_name: record.name, url: record.origin.url ?? record.origin.label, tools: [],
    // ClawHub 来源单独标记，能力页显示平台名；本地导入仍归 user_import（显示「自定义」）。
    source: record.origin.kind === "clawhub" ? "clawhub_catalog" : "user_import",
    version: record.version, source_ref: "", reason: "", approved_by: owner.memberId,
  });
  return store.listLocalCapabilities(owner.tenantId, owner.memberId).find((item) => item.kind === "skill" && item.ref === record.name)!;
}

/**
 * Desktop «能力» page «添加技能»: the member installs, by their own action, a skill the enterprise opened to them —
 * the same catalog, package fetch and signature check as an approved chat install; no conversation, no model.
 */
export async function installSkillDirectly(store: AgentSqliteStore, owner: TaskOwner, skills: SkillInstaller | undefined, request: { skill_id: string; replace?: boolean }, signal?: AbortSignal): Promise<LocalCapability> {
  if (!skills) throw new SkillInstallError("manager_unavailable", "暂时无法连接企业服务，请稍后再试。");
  const plan = await planInstall(store, owner, { kind: "skill", ref: request.skill_id, reason: "" }, skills, undefined, signal);
  if (typeof plan === "string") {
    const installedAlready = store.listLocalCapabilities(owner.tenantId, owner.memberId).some(item => item.kind === "skill" && item.ref === request.skill_id);
    if (installedAlready && plan.includes("已安装")) throw new SkillInstallError("skill_installed", plan);
    if (plan.includes("暂时无法") || plan.includes("未连接")) throw new SkillInstallError("manager_unavailable", plan.replace("安装未完成：", ""));
    throw new SkillInstallError("skill_not_installable", "企业技能目录里没有这个可自行安装的技能，请联系企业管理员。");
  }
  if (plan.existing && !request.replace) throw new SkillInstallError("skill_exists", `「${plan.existing.display_name}」已经装好了（${plan.existing.version ?? ""} 版）；需要换成目录里的 ${plan.skill!.version} 版才点替换安装。`);
  const outcome = await installPlannedSkill(store, owner, plan, skills, owner.memberId, signal);
  if ("error" in outcome) throw new SkillInstallError(outcome.error === "signature" ? "skill_signature_invalid" : "skill_install_failed", outcome.text);
  return outcome.capability;
}

/** «添加 MCP» window: tells whether the address needs sign-in or a token, before the member fills in the rest. */
export async function probeMcpUrl(rawUrl: string, auth?: McpRuntimeAuth, signal?: AbortSignal): Promise<McpProbe> {
  let url: URL;
  try {
    if (String(rawUrl ?? "").length > MAX_MCP_URL) throw new Error("too long");
    url = validMcpUrl(String(rawUrl));
  } catch { throw new McpInstallError("invalid_mcp", "地址无效：须为 https（或本机地址），不含账号、查询串。"); }
  try { return await (auth?.probe ?? probeMcpAuth)(url.toString(), signal); } catch { throw new McpInstallError("mcp_install_failed", "无法连接这个地址，请检查地址或稍后再试。"); }
}

function installedMcp(store: AgentSqliteStore, owner: TaskOwner, ref: string): LocalCapability | undefined {
  return store.listLocalCapabilities(owner.tenantId, owner.memberId).find(item => item.kind === "mcp" && item.ref === ref);
}

/** Settings «重新登录»: signs the member in again for an installed OAuth MCP; the install record is not touched. */
export async function startMcpRelogin(store: AgentSqliteStore, owner: TaskOwner, auth: McpRuntimeAuth, ref: string): Promise<{ found: boolean; login?: McpLogin }> {
  const item = installedMcp(store, owner, ref);
  if (!item || item.auth !== "oauth") return { found: false };
  if (!auth.service) throw new McpInstallError("mcp_install_failed", "本机暂时无法保存这个 MCP 的登录凭据，请稍后再试。");
  const stored = auth.service.credentials.get(owner, ref, item.url);
  const client = stored?.catalog_client ? catalogClient(auth, stored.catalog_client) : item.source === "platform_catalog" ? catalogClient(auth, item.source_ref) : undefined;
  try {
    const { login } = await auth.service.login(owner, ref, item.url, { ...(item.oauth_scope ? { scope: item.oauth_scope } : {}), ...(client ? { client } : {}) });
    return { found: true, ...(login ? { login } : {}) };
  } catch (error) {
    throw new McpInstallError("mcp_install_failed", loginFailureText(error, item.display_name || ref).replace("安装未完成：", "登录未完成："));
  }
}

/** Settings «更新令牌»: checks the token against the server first; a rejected token is not saved. */
export async function updateMcpToken(store: AgentSqliteStore, owner: TaskOwner, auth: McpRuntimeAuth, ref: string, credential: McpBearerCredential): Promise<boolean> {
  const item = installedMcp(store, owner, ref);
  if (!item || item.auth !== "bearer") return false;
  if (!auth.service) throw new McpInstallError("mcp_install_failed", "本机暂时无法保存这个 MCP 的访问令牌，请稍后再试。");
  const header = credential.header ?? item.auth_header;
  if (!credential.token || !validBearerHeader(header)) throw new McpInstallError("invalid_mcp", "令牌或请求头名无效。");
  await verifyMcpBearer(item.url, { token: credential.token, header });
  auth.service.credentials.put(owner, ref, { url: item.url, auth: "bearer", token: credential.token, ...(header ? { header } : {}) });
  return true;
}

/** Reads the tool list with the token; throws McpInstallError when the server rejects it. Other failures pass (the install reports them). */
export async function verifyMcpBearer(url: string, credential: McpBearerCredential, signal?: AbortSignal): Promise<void> {
  try {
    await listMcpTools({ url, headers: bearerHeaders(credential) }, signal);
  } catch (error) {
    if (isMcpAuthFailure(error)) throw new McpInstallError("mcp_install_failed", "服务方拒绝了这个访问令牌（无效或已过期），请检查后重新填写。");
  }
}
