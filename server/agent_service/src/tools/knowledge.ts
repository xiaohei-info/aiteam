import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthenticatedCaller } from "../http/auth.js";
import { ManagerUnavailableError, type ManagerClient } from "../manager-client.js";

export interface KnowledgeToolContext {
  caller: AuthenticatedCaller;
  employeeId: string;
  knowledgeRefs: readonly string[];
  managerClient?: ManagerClient;
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
        if (!context.managerClient?.knowledgeSearch) return unavailableResult();
        try {
          const data = await context.managerClient.knowledgeSearch(
            context.caller,
            context.employeeId,
            context.knowledgeRefs,
            params.query,
            params.limit,
          );
          return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
        } catch (error) {
          if (error instanceof ManagerUnavailableError) return unavailableResult();
          throw error;
        }
      },
    }),
    defineTool({
      name: "knowledge_get",
      label: "Get knowledge citation",
      description: "Get a citation from the knowledge artifacts authorized for the current employee snapshot.",
      promptSnippet: "knowledge_get(citation_id)",
      parameters: getParameters,
      execute: async (_toolCallId, params) => {
        if (!context.managerClient?.knowledgeGet) return unavailableResult();
        try {
          const data = await context.managerClient.knowledgeGet(
            context.caller,
            context.employeeId,
            context.knowledgeRefs,
            params.citation_id,
          );
          return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
        } catch (error) {
          if (error instanceof ManagerUnavailableError) return unavailableResult();
          throw error;
        }
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
