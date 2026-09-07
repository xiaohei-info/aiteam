import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SessionAuthorization } from "./session-host.js";

const SEARCH_TOOL = "knowledge_search";
const GET_TOOL = "knowledge_get";
const RAG_TOOLS = new Set([SEARCH_TOOL, GET_TOOL]);
const searchInput = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8_000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
}, { additionalProperties: false });
const getInput = Type.Object({
  citation_id: Type.String({ minLength: 1, maxLength: 1_024 }),
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
    if (!tools.includes(SEARCH_TOOL) || tools.some((name) => !RAG_TOOLS.has(name)) || new Set(tools).size !== tools.length) {
      throw new Error("RAG MCP tool inventory is not allowed");
    }
  }

  async search(query: string, limit: number): Promise<unknown> {
    const result = await this.client.callTool({ name: SEARCH_TOOL, arguments: { query, limit } });
    if (result.isError) throw new Error("Knowledge access unavailable");
    return result;
  }

  async get(citation_id: string): Promise<unknown> {
    const result = await this.client.callTool({ name: GET_TOOL, arguments: { citation_id } });
    if (result.isError) throw new Error("Knowledge access unavailable");
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
    if ((manager.protocol !== "http:" && manager.protocol !== "https:") || manager.username || manager.password || rag.username || rag.password || rag.origin !== manager.origin) return undefined;
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
  if (!ragMcpUrl(managerUrl)) return [];
  const knowledge = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>).knowledge_policy : undefined;
  if (knowledge !== undefined && knowledge !== null) {
    if (typeof knowledge !== "object") return [];
    const value = knowledge as Record<string, unknown>;
    const operations = value.allowed_operations;
    if (value.state === "deny" || !["inherit", "allow"].includes(String(value.state)) || !Array.isArray(operations)) return [];
    return [SEARCH_TOOL, GET_TOOL].filter((name) => operations.includes(name) && (allowed.length === 0 || allowed.includes(name)));
  }
  // Old snapshots used an empty allowlist for platform defaults; a new
  // knowledge_policy with [] must never take this compatibility fallback.
  if (allowed.length === 0) return [SEARCH_TOOL, GET_TOOL];
  return [SEARCH_TOOL, GET_TOOL].filter((name) => allowed.includes(name));
}

/** Controlled extension: no .mcp.json, home-directory, or ambient server discovery. */
export function createRagMcpFactory(authorization: SessionAuthorization, managerUrl?: string): ((pi: ExtensionAPI) => void) | undefined {
  const url = ragMcpUrl(managerUrl);
  const toolNames = ragToolNames(authorization.snapshot, managerUrl);
  if (!url || toolNames.length === 0 || !authorization.caller.accessToken) return undefined;
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
    if (toolNames.includes(SEARCH_TOOL)) pi.registerTool(defineTool({
      name: SEARCH_TOOL,
      label: "Search knowledge",
      description: "Search authorized enterprise knowledge and return explicit citations.",
      promptSnippet: "knowledge_search(query, limit)",
      parameters: searchInput,
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
    if (toolNames.includes(GET_TOOL)) {
      pi.registerTool(defineTool({
        name: GET_TOOL,
        label: "Get knowledge citation",
        description: "Get bounded text for an authorized knowledge citation.",
        promptSnippet: "knowledge_get(citation_id)",
        parameters: getInput,
        execute: async (_toolCallId, params) => {
          try {
            const values = params as { citation_id: string };
            const result = await (await getClient()).get(values.citation_id);
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
          } catch {
            return { content: [{ type: "text" as const, text: "Knowledge service unavailable; no local enterprise index was used." }], details: undefined, isError: true };
          }
        },
      } as ToolDefinition));
    }
    pi.on("session_shutdown", async (_event: unknown, _context: ExtensionContext) => shutdown());
  };
}
