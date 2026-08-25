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

const delegateParameters = Type.Object({
  employee_id: Type.String({ minLength: 1, maxLength: 256 }),
  task: Type.String({ minLength: 1, maxLength: 8_000 }),
  context: Type.Optional(Type.String({ maxLength: 8_000 })),
});

const mentionParameters = Type.Object({
  employee_id: Type.String({ minLength: 1, maxLength: 256 }),
  message: Type.String({ minLength: 1, maxLength: 8_000 }),
  context: Type.Optional(Type.String({ maxLength: 8_000 })),
});

function createMentionTool(name: "mention_employee" | "delegate_employee", context: DelegateEmployeeContext): ToolDefinition {
  const parameters = name === "mention_employee" ? mentionParameters : delegateParameters;
  return defineTool({
    name,
    label: name === "mention_employee" ? "Mention employee" : "Delegate employee",
    description: "Send a bounded message to an authorized employee in this group conversation and receive that employee's reply.",
    promptSnippet: name === "mention_employee" ? "mention_employee(employee_id, message, context)" : "delegate_employee(employee_id, task, context)",
    parameters,
    ...(name === "mention_employee" ? {
      prepareArguments(args: unknown) {
        if (!args || typeof args !== "object") return args as { employee_id: string; message: string; context?: string };
        const raw = args as { message?: unknown; task?: unknown };
        if (typeof raw.message === "string" || typeof raw.task !== "string") return args as { employee_id: string; message: string; context?: string };
        return { ...(args as Record<string, unknown>), message: raw.task } as { employee_id: string; message: string; context?: string };
      },
    } : {}),
    executionMode: "parallel",
    execute: async (toolCallId, params, signal) => {
      try {
        const raw = params as { employee_id: string; message?: string; task?: string; context?: string };
        const input: DelegateEmployeeInput = {
          employee_id: raw.employee_id,
          task: raw.message ?? raw.task ?? "",
          ...(raw.context ? { context: raw.context } : {}),
        };
        const text = await context.delegate(toolCallId, input, signal);
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
