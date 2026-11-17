import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSqliteStore, FrozenSnapshot } from "./storage/sqlite.js";
import { AutomationError, type TaskOwner } from "./storage/automation-tasks.js";

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

/**
 * The model may only *ask* to install: this tool is unknown to the approval classifier, so it always needs a human
 * decision, and the approval preview shows the URL. After approval the server is contacted and its real tool list stored.
 * No credentials can be passed through the model; a server that needs one is not supported here.
 */
export function capabilityInstallTool(store: AgentSqliteStore, owner: TaskOwner): ToolDefinition {
  return {
    name: "capability_install",
    label: "Install MCP capability",
    description: "Ask the user to install an MCP server for themselves. Call it only when the task truly needs a capability you do not have, "
      + "and only with an https (or localhost) URL the user gave you or the solution recommended. Never invent URLs. The user must approve; do not retry after a denial.",
    parameters: Type.Object({
      kind: Type.Literal("mcp"),
      ref: Type.String({ description: "short id: lowercase letters, digits, - or _" }),
      display_name: Type.String({ minLength: 1, maxLength: 120 }),
      url: Type.String({ description: "MCP endpoint (streamable HTTP)" }),
      reason: Type.String({ maxLength: 200, description: "why the task needs it" }),
    }, { additionalProperties: false }),
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const input = params as { ref: string; display_name: string; url: string; reason: string };
      try {
        if (!REF_RE.test(input.ref)) throw new Error("invalid ref");
        const url = validMcpUrl(input.url);
        const tools = (await listMcpTools(url.toString(), signal)).filter(name => TOOL_RE.test(name)).slice(0, 50);
        if (!tools.length) throw new Error("no tools");
        store.putLocalCapability(owner.tenantId, owner.memberId, {
          kind: "mcp", ref: input.ref, display_name: input.display_name.slice(0, 120), url: url.toString(), tools,
          source: "user_url", reason: (input.reason ?? "").slice(0, 200), approved_by: owner.memberId,
        });
        return { content: [{ type: "text" as const, text: `已安装 ${input.display_name}，可用工具：${tools.join(", ")}。下一轮对话起可调用。` }], details: undefined };
      } catch {
        return { content: [{ type: "text" as const, text: "安装未完成：地址无效、服务无法连接或没有可用工具。请让用户检查地址。" }], details: undefined, isError: true };
      }
    },
  } as ToolDefinition;
}
