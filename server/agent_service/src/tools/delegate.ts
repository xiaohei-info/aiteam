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

export function createDelegateEmployeeTool(context: DelegateEmployeeContext): ToolDefinition {
  return defineTool({
    name: "delegate_employee",
    label: "Delegate to employee",
    description: "Delegate a bounded task to an authorized local employee and receive a concise result.",
    promptSnippet: "delegate_employee(employee_id, task, context)",
    parameters,
    executionMode: "parallel",
    execute: async (toolCallId, params, signal) => {
      try {
        const text = await context.delegate(toolCallId, params, signal);
        return { content: [{ type: "text", text }], details: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Employee delegation failed";
        return {
          content: [{ type: "text" as const, text: `delegate_employee error: ${message}` }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
