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
    },
  } as ToolDefinition));
}
