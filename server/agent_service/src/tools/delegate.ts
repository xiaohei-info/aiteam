import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface DelegateEmployeeInput {
  employee_id: string;
  task: string;
  context?: string;
}

export interface DelegateEmployeeContext {
  delegate: (toolCallId: string, input: DelegateEmployeeInput, signal?: AbortSignal) => Promise<string>;
}

const parameters = Type.Object({
  employee_id: Type.String({ minLength: 1, maxLength: 256 }),
  task: Type.String({ minLength: 1, maxLength: 8_000 }),
  context: Type.Optional(Type.String({ maxLength: 8_000 })),
});

function createMentionTool(name: "mention_employee" | "delegate_employee", context: DelegateEmployeeContext): ToolDefinition {
  return defineTool({
    name,
    label: name === "mention_employee" ? "Mention employee" : "Delegate employee",
    description: "Send a bounded message to an authorized employee in this group conversation and receive that employee's reply.",
    promptSnippet: `${name}(employee_id, task, context)`,
    parameters,
    executionMode: "parallel",
    execute: async (toolCallId, params, signal) => {
      try {
        const text = await context.delegate(toolCallId, params, signal);
        return { content: [{ type: "text", text }], details: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Employee mention failed";
        return {
          content: [{ type: "text" as const, text: `${name} error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}

export function createMentionEmployeeTool(context: DelegateEmployeeContext): ToolDefinition {
  return createMentionTool("mention_employee", context);
}

/** @deprecated Kept as a short-lived snapshot compatibility alias. It uses the same fixed participant session. */
export function createDelegateEmployeeTool(context: DelegateEmployeeContext): ToolDefinition {
  return createMentionTool("delegate_employee", context);
}
