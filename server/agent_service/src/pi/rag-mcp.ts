import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionAuthorization } from "./session-host.js";

const RAG_TOOL = "knowledge_search";
const input = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8_000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
}, { additionalProperties: false });

class RagMcpClient {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;

  constructor(url: string, authorization: SessionAuthorization) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("RAG MCP URL must use HTTP(S)");
    const token = authorization.caller.accessToken;
    if (!token) throw new Error("Agent access token is unavailable");
    this.transport = new StreamableHTTPClientTransport(parsed, {
      requestInit: { headers: {
        Authorization: `Bearer ${token}`,
        "X-AITeam-Employee-ID": authorization.employeeId,
      } },
    });
    this.client = new Client({ name: "aiteam-agent", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    const inventory = await this.client.listTools();
    const tools = inventory.tools.map((tool) => tool.name);
    if (tools.length !== 1 || tools[0] !== RAG_TOOL) throw new Error("RAG MCP tool inventory is not allowed");
  }

  async search(query: string, limit: number): Promise<unknown> {
    const result = await this.client.callTool({ name: RAG_TOOL, arguments: { query, limit } });
    return result;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}

export function ragMcpUrl(managerUrl = process.env.AITEAM_MANAGER_URL): string | undefined {
  const configured = process.env.AITEAM_RAG_MCP_URL?.trim();
  if (!configured || !managerUrl?.trim()) return undefined;
  try {
    const manager = new URL(managerUrl);
    const rag = new URL(configured);
    if ((manager.protocol !== "http:" && manager.protocol !== "https:") || rag.origin !== manager.origin) return undefined;
    if (rag.pathname !== "/api/manager/rag/mcp" || rag.search || rag.hash) return undefined;
    return rag.toString();
  } catch {
    return undefined;
  }
}

export function ragToolNames(snapshot: unknown, managerUrl?: string): string[] {
  const policy = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>).tool_policy : undefined;
  const allowed: unknown[] = policy && typeof policy === "object" && Array.isArray((policy as Record<string, unknown>).allowed_tools)
    ? (policy as Record<string, unknown>).allowed_tools as unknown[] : [];
  return ragMcpUrl(managerUrl) && (allowed as unknown[]).includes(RAG_TOOL) ? [RAG_TOOL] : [];
}

/** Controlled extension: no .mcp.json, home-directory, or ambient server discovery. */
export function createRagMcpFactory(authorization: SessionAuthorization, managerUrl?: string): ((pi: ExtensionAPI) => void) | undefined {
  const url = ragMcpUrl(managerUrl);
  if (!url || !authorization.caller.accessToken) return undefined;
  let client: RagMcpClient | undefined;
  let connectPromise: Promise<RagMcpClient> | undefined;
  const getClient = async () => {
    if (client) return client;
    if (!connectPromise) {
      connectPromise = (async () => {
        const next = new RagMcpClient(url, authorization);
        await next.connect();
        client = next;
        return next;
      })();
    }
    return connectPromise;
  };
  const shutdown = async () => {
    const active = client;
    client = undefined;
    connectPromise = undefined;
    await active?.close();
  };
  return (pi: ExtensionAPI) => {
    pi.registerTool(defineTool({
      name: RAG_TOOL,
      label: "Search knowledge",
      description: "Search authorized enterprise knowledge and return explicit citations.",
      promptSnippet: "knowledge_search(query, limit)",
      parameters: input,
      execute: async (_toolCallId, params) => {
        try {
          const values = params as { query: string; limit?: number };
          const result = await (await getClient()).search(values.query, values.limit ?? 10);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
        } catch {
          return { content: [{ type: "text" as const, text: "Knowledge service unavailable; no local enterprise index was used." }], details: undefined, isError: true };
        }
      },
    } as ToolDefinition));
    pi.on("session_shutdown", async (_event: unknown, _context: ExtensionContext) => shutdown());
  };
}
