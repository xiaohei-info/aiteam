import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthenticatedCaller } from "../http/auth.js";
import type { AgentSqliteStore, KnowledgeArtifact } from "../storage/sqlite.js";

export interface KnowledgeCitation extends KnowledgeArtifact { text: string; }
export interface KnowledgeSearchResult { items: KnowledgeCitation[]; query: string; }
export interface KnowledgeGetResult { citation: KnowledgeCitation | null; }

/** Local-only knowledge seam; implementations must enforce the bound employee/ref closure. */
export interface LocalKnowledgeIndex {
  search(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], query: string, limit: number): Promise<unknown>;
  get(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], citationId: string): Promise<unknown>;
}

/** Deterministic local index. It deliberately does not depend on Manager or LightRAG. */
export class SqliteKnowledgeIndex implements LocalKnowledgeIndex {
  constructor(private readonly store: AgentSqliteStore) {}

  async search(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], query: string, limit: number): Promise<KnowledgeSearchResult> {
    const rows = this.rows(caller, employeeId, knowledgeRefs);
    const terms = [...tokenize(query)];
    const scored = rows.map((row) => {
      const haystack = tokenize(`${row.title} ${row.source.name ?? ""} ${row.content}`);
      const score = terms.reduce((total, term) => total + (haystack.has(term) ? 1 : 0), 0);
      return { row, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.row.citation_id.localeCompare(b.row.citation_id));
    return { items: scored.slice(0, Math.max(1, Math.min(limit, 100))).map(({ row }) => toCitation(row)), query };
  }

  async get(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], citationId: string): Promise<KnowledgeGetResult> {
    return { citation: this.toOwnedCitation(caller, employeeId, knowledgeRefs, citationId) };
  }

  private rows(caller: AuthenticatedCaller, employeeId: string, refs: readonly string[]): KnowledgeArtifact[] {
    return this.store.listKnowledgeArtifacts(caller.tenantId!, caller.userId ?? caller.callerId, employeeId).filter((row) => refs.includes(row.knowledge_space_id));
  }

  private toOwnedCitation(caller: AuthenticatedCaller, employeeId: string, refs: readonly string[], citationId: string): KnowledgeCitation | null {
    const row = this.store.getKnowledgeArtifact(caller.tenantId!, caller.userId ?? caller.callerId, employeeId, refs, citationId);
    return row ? toCitation(row) : null;
  }
}

function tokenize(value: string): Set<string> { return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []); }
function toCitation(row: KnowledgeArtifact): KnowledgeCitation { return { ...row, text: row.content }; }

export interface KnowledgeToolContext {
  caller: AuthenticatedCaller;
  employeeId: string;
  knowledgeRefs: readonly string[];
  localKnowledgeIndex?: LocalKnowledgeIndex;
}

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8_000 }),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
});
const getParameters = Type.Object({
  citation_id: Type.String({ minLength: 1, maxLength: 512 }),
});

export function createKnowledgeTools(context: KnowledgeToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "knowledge_search",
      label: "Search knowledge",
      description: "Search the knowledge artifacts authorized for the current employee snapshot.",
      promptSnippet: "knowledge_search(query, limit)",
      parameters: searchParameters,
      execute: async (_toolCallId, params) => {
        if (!context.localKnowledgeIndex) return unavailableResult();
        const data = await context.localKnowledgeIndex.search(
          context.caller,
          context.employeeId,
          context.knowledgeRefs,
          params.query,
          params.limit,
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
      },
    }),
    defineTool({
      name: "knowledge_get",
      label: "Get knowledge citation",
      description: "Get a citation from the knowledge artifacts authorized for the current employee snapshot.",
      promptSnippet: "knowledge_get(citation_id)",
      parameters: getParameters,
      execute: async (_toolCallId, params) => {
        if (!context.localKnowledgeIndex) return unavailableResult();
        const data = await context.localKnowledgeIndex.get(
          context.caller,
          context.employeeId,
          context.knowledgeRefs,
          params.citation_id,
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
      },
    }),
  ];
}

function unavailableResult() {
  return {
    content: [{ type: "text" as const, text: "Knowledge service unavailable; no remote artifact was read." }],
    details: undefined,
    isError: true,
  };
}
