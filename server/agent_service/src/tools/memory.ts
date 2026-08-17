import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AuthenticatedCaller } from "../http/auth.js";
import { ManagerUnavailableError, type ManagerClient } from "../manager-client.js";

export interface MemoryToolContext {
  caller: AuthenticatedCaller;
  employeeId: string;
  managerClient?: ManagerClient;
}

const recallParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 8_000 }),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
});
const retainParameters = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 20_000 }),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function createMemoryTools(context: MemoryToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "memory_recall",
      label: "Recall memory",
      description: "Recall authorized cross-session memory for the current employee.",
      promptSnippet: "memory_recall(query, limit)",
      parameters: recallParameters,
      execute: async (_toolCallId, params) => {
        if (!context.managerClient?.memoryRecall) return unavailableResult();
        try {
          const data = await context.managerClient.memoryRecall(context.caller, context.employeeId, params.query, params.limit);
          return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
        } catch (error) {
          if (error instanceof ManagerUnavailableError) return unavailableResult();
          throw error;
        }
      },
    }),
    defineTool({
      name: "memory_retain",
      label: "Retain memory",
      description: "Retain explicitly supplied, non-sensitive information in authorized cross-session memory.",
      promptSnippet: "memory_retain(content, metadata)",
      parameters: retainParameters,
      execute: async (_toolCallId, params) => {
        if (!context.managerClient?.memoryRetain) return unavailableResult();
        try {
          const data = await context.managerClient.memoryRetain(
            context.caller,
            context.employeeId,
            sanitizeContent(params.content),
            sanitizeMetadata(params.metadata ?? {}),
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
    content: [{ type: "text" as const, text: "Memory service unavailable; continuing with local Pi Session only." }],
    details: undefined,
    isError: true,
  };
}

function sanitizeContent(content: string): string {
  return content
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .slice(0, 20_000);
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|token|secret|password|credential|api[_ -]?key/i.test(key)) continue;
    if (typeof item === "string") output[key] = sanitizeContent(item).slice(0, 2_000);
    else if (Array.isArray(item)) output[key] = item.slice(0, 32);
    else if (item && typeof item === "object") output[key] = sanitizeMetadata(item as Record<string, unknown>);
    else output[key] = item;
  }
  return output;
}
