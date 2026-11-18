import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSqliteStore, CapabilityResolution, FrozenSnapshot, LocalCapability } from "./storage/sqlite.js";
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

interface McpTarget { url: string; token_env?: string }

/** One MCP tool call over a fresh transport; the credential stays in the process environment and is redacted from the result. */
async function callMcpTool(config: McpTarget, input: { tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Connector call cancelled");
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const token = config.token_env ? process.env[config.token_env] : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { redirect: "error", signal: combined, headers: token ? { Authorization: `Bearer ${token}` } : {} } });
  const client = new Client({ name: "aiteam-connector", version: "1.0.0" });
  try {
    await client.connect(transport, { signal: combined });
    const inventory = await client.listTools({}, { signal: combined });
    if (!inventory.tools.some(tool => tool.name === input.tool)) throw new Error();
    const result = await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, { signal: combined, timeout: 30_000 });
    let text = JSON.stringify(result);
    if (token) text = text.split(token).join("[凭据已隐藏]");
    return { content: [{ type: "text" as const, text: text.slice(0, 50_000) }], details: undefined, isError: Boolean(result.isError) };
  } catch { return { content: [{ type: "text" as const, text: "连接器调用未能确认成功，请检查服务与审批记录；不要自动重试有副作用的操作。" }], details: undefined, isError: true }; }
  finally { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }
}

/** Lists the tools an MCP server really exposes; used to check an install request before it is stored. */
export async function listMcpTools(url: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { redirect: "error", signal: combined } });
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
      return callMcpTool(config, input, signal);
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
export function personalConnectorTools(store: AgentSqliteStore, owner: TaskOwner, snapshot: FrozenSnapshot): ToolDefinition[] {
  return store.listLocalCapabilities(owner.tenantId, owner.memberId).filter(item => item.kind === "mcp" && permitsConnectorTool(snapshot, `my_${item.ref}`)).map(item => ({
    name: `connector_my_${item.ref}`,
    label: item.display_name,
    description: `Call a tool of ${item.display_name}, an MCP server the user installed for themselves. Allowed tools: ${item.tools.join(", ")}. External actions require approval.`,
    parameters: Type.Object({ tool: Type.String({ enum: item.tools }), arguments: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const current = store.listLocalCapabilities(owner.tenantId, owner.memberId).find(row => row.kind === "mcp" && row.ref === item.ref);
      const input = params as { tool: string; arguments: Record<string, unknown> };
      if (!current || !current.tools.includes(input.tool) || !input.arguments || Array.isArray(input.arguments) || typeof input.arguments !== "object") throw new Error("Connector tool is not authorized");
      return callMcpTool({ url: current.url }, input, signal);
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
/** A credential-free platform MCP server the enterprise enabled (Manager `GET /grants/mcp-servers`, design §11.3). */
export interface InstallableMcpInfo { server_id: string; ref: string; display_name: string; summary: string; url: string; tools: string[]; revision: number }
/** Manager-backed platform MCP catalog; absent without Manager. */
export interface McpCatalog { list(signal?: AbortSignal): Promise<InstallableMcpInfo[]> }

export interface CapabilityInstallInput {
  kind: "mcp" | "skill";
  ref: string;
  display_name?: string;
  url?: string;
  reason?: string;
  /** Set only by the approval gate from the user's decision; the model cannot pass it (schema forbids extra fields). */
  resolution?: CapabilityResolution | null;
  /** Set only by the approval gate: the record was approved by the member's auto-install grant, not a prompt. */
  autoApproved?: boolean;
}
export type CapabilityInstallCheck =
  | { ok: true; summary: string; kind: "mcp" | "skill"; /** source is our platform catalog */ platform: boolean; /** an installed same-ref capability would be replaced */ replaces: boolean }
  | { ok: false; message: string };

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });
const INVALID_MCP = "安装未完成：标识或地址无效（地址须为 https 或本机地址，且不含账号、查询串）。请让用户检查。";

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
  existing?: LocalCapability;
  reason: string;
}

async function planInstall(store: AgentSqliteStore, owner: TaskOwner, input: CapabilityInstallInput, skills: SkillInstaller | undefined, mcps: McpCatalog | undefined, signal?: AbortSignal): Promise<InstallPlan | string> {
  const installed = store.listLocalCapabilities(owner.tenantId, owner.memberId);
  const reason = String(input.reason ?? "").slice(0, 200);
  if (input.kind === "skill") {
    const found = await findSkill(skills, String(input.ref ?? ""), signal);
    if (typeof found === "string") return found;
    const existing = installed.find(item => item.kind === "skill" && item.ref === found.skill_id);
    if (existing?.version === found.version) return `技能「${found.display_name || found.skill_id}」${found.version} 已安装，下一轮对话起可用，无需再装。`;
    return {
      kind: "skill", ref: found.skill_id, display_name: found.display_name.slice(0, 120), url: "", declaredTools: [],
      source: found.origin === "platform" ? "platform_catalog" : "enterprise_catalog", sourceRef: found.source_skill_id, skill: found, existing, reason,
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
    return {
      kind: "mcp", ref, display_name: entry.display_name.slice(0, 120), url: url.toString(), declaredTools: entry.tools,
      source: "platform_catalog", sourceRef: entry.server_id, existing, reason,
    };
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
  return { kind: "mcp", ref, display_name: String(input.display_name ?? "").slice(0, 120), url: url.toString(), declaredTools: [], source: "user_url", sourceRef: "", existing, reason };
}

function summaryOf(plan: InstallPlan): string {
  const base = { kind: plan.kind, ref: plan.ref, display_name: plan.display_name, source: plan.source, reason: plan.reason };
  if (plan.kind === "skill") {
    return JSON.stringify({ ...base, version: plan.skill!.version, ...(plan.existing ? { replaces: { display_name: plan.existing.display_name, version: plan.existing.version } } : {}) });
  }
  return JSON.stringify({ ...base, url: plan.url, ...(plan.existing ? { replaces: { display_name: plan.existing.display_name, url: plan.existing.url } } : {}) });
}

/**
 * Runs before the approval prompt. Requests that can never succeed (bad ref/URL, skill not in the enterprise catalog,
 * the same skill version already installed) are bounced back to the model without bothering the user. A same-ref clash
 * is NOT bounced: the user decides in the approval dialog (replace / rename / cancel), so the summary names what would
 * be replaced. The summary is stored in the approval record and holds nothing the install itself does not accept;
 * its `source` tells the dialog whether «以后直接安装» may be offered (platform catalog only).
 */
export async function checkCapabilityInstall(store: AgentSqliteStore, owner: TaskOwner, params: unknown, skills?: SkillInstaller, signal?: AbortSignal, mcps?: McpCatalog): Promise<CapabilityInstallCheck> {
  const plan = await planInstall(store, owner, params as CapabilityInstallInput, skills, mcps, signal);
  if (typeof plan === "string") return { ok: false, message: plan };
  return { ok: true, summary: summaryOf(plan), kind: plan.kind, platform: plan.source === "platform_catalog", replaces: Boolean(plan.existing) };
}

/**
 * The model may only *ask* to install: this tool is unknown to the approval classifier, so it needs a human decision,
 * or the member's own auto-install grant for this kind from our platform catalog (design §11.3). A clash with an
 * installed capability is resolved by the user in the approval dialog (replace / rename for MCP / cancel); without that
 * choice nothing is overwritten. MCP: the server is contacted and its real tool list stored (for a catalog entry, only
 * tools the catalog declares); no credentials pass through the model. Skill: the package signed for this member is
 * verified before it is stored.
 */
export function capabilityInstallTool(store: AgentSqliteStore, owner: TaskOwner, skills?: SkillInstaller, mcps?: McpCatalog): ToolDefinition {
  return {
    name: "capability_install",
    label: "Install capability",
    description: "Ask the user to install a capability for themselves. Call it only when the task truly needs one you do not have. "
      + "kind=skill: ref is a skill id from the enterprise skill catalog or the solution's recommended skills. "
      + "kind=mcp: ref may be the id of an MCP the enterprise enabled from the platform catalog (no url needed; the catalog address is used); "
      + "otherwise give an https (or localhost) url the user gave you or the solution recommended; never invent URLs. "
      + "The user must approve (and decides about replacing an installed one); do not retry after a denial.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("mcp"), Type.Literal("skill")]),
      ref: Type.String({ description: "mcp: short id (lowercase letters, digits, - or _); skill: the skill id" }),
      display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      url: Type.Optional(Type.String({ description: "MCP endpoint (streamable HTTP); not used for a skill or a catalog MCP" })),
      reason: Type.String({ maxLength: 200, description: "why the task needs it" }),
    }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const input = params as CapabilityInstallInput;
      const resolution = input.resolution ?? undefined;
      // Re-planned here as well: the approval may have waited while another install or the catalogs changed.
      const plan = await planInstall(store, owner, input, skills, mcps, signal);
      if (typeof plan === "string") return fail(plan);
      // Auto-approval covered only a platform-catalog install that replaced nothing; anything else needs the user again.
      if (input.autoApproved && (plan.source !== "platform_catalog" || plan.existing)) {
        return fail("安装未完成：能力目录或本机已装能力在批准后发生了变化，请重新发起安装请求。");
      }
      const approvedBy = input.autoApproved ? AUTO_INSTALL_APPROVER : owner.memberId;
      if (plan.kind === "skill") {
        const found = plan.skill!;
        if (resolution?.action === "rename") return fail("技能不能改名安装；用户可以选择覆盖或取消。");
        if (plan.existing && resolution?.action !== "replace") return fail("已装有该技能的其他版本，用户没有选择覆盖，未安装。");
        try {
          await skills!.install(found.skill_id, signal);
        } catch (error) {
          if (!(error instanceof SkillVerificationError)) return fail("安装未完成：企业服务暂不可用，请稍后再试。");
          // 签名校验不过（通常是企业更换或吊销了签名密钥）：不可以安装；已装的版本不动，照常可用。
          const kept = plan.existing;
          return fail(kept
            ? `不可以安装：「${found.display_name || found.skill_id}」${found.version} 的技能包签名校验未通过（企业可能更换了签名密钥）。本机已装的 ${kept.version ?? ""} 版不受影响，仍可继续使用。`
            : `不可以安装：「${found.display_name || found.skill_id}」的技能包签名校验未通过（企业可能更换了签名密钥）。请告诉用户联系企业管理员。`);
        }
        store.putLocalCapability(owner.tenantId, owner.memberId, {
          kind: "skill", ref: found.skill_id, display_name: found.display_name || found.skill_id, url: "", tools: [], version: found.version, source_ref: plan.sourceRef,
          source: plan.source, reason: plan.reason, approved_by: approvedBy,
        });
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
      const catalog = plan.source === "platform_catalog";
      try {
        const advertised = (await listMcpTools(plan.url, signal)).filter(name => TOOL_RE.test(name)).slice(0, 50);
        const tools = catalog ? advertised.filter(name => plan.declaredTools.includes(name)) : advertised;
        if (!tools.length) throw new Error("no tools");
        const name = (plan.display_name || ref).slice(0, 120);
        store.putLocalCapability(owner.tenantId, owner.memberId, {
          kind: "mcp", ref, display_name: name, url: plan.url, tools, source_ref: plan.sourceRef,
          source: plan.source, reason: plan.reason, approved_by: approvedBy,
        });
        return { content: [{ type: "text" as const, text: `已安装 ${name}（标识 ${ref}），可用工具：${tools.join(", ")}。下一轮对话起可调用。` }], details: undefined };
      } catch {
        return fail(catalog
          ? "安装未完成：企业 MCP 目录里的这个服务暂时无法连接，或没有目录声明的工具。请稍后再试或告诉用户联系企业管理员。"
          : "安装未完成：地址无效、服务无法连接或没有可用工具。请让用户检查地址。");
      }
    },
  } as ToolDefinition;
}
