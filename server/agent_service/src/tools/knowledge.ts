import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthenticatedCaller } from "../http/auth.js";

/** Local-only knowledge seam; implementations must enforce the bound employee/ref closure. */
export interface LocalKnowledgeIndex {
  search(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], query: string, limit: number): Promise<unknown>;
  get(caller: AuthenticatedCaller, employeeId: string, knowledgeRefs: readonly string[], citationId: string): Promise<unknown>;
}

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
