import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TODO_UPDATE_TOOL_NAME = "todo_update";
export const MAX_TODO_ITEMS = 32;
export const MAX_TODO_ID_CHARS = 128;
export const MAX_TODO_TITLE_CHARS = 500;

const INLINE_SECRET = /(?:bearer\s+|basic\s+|(?:sk|pk|rk)-)[a-z0-9._~+/=-]+|(?:token|secret|password|api[ _-]?key)\s*[:=]\s*[^\s,;]+/gi;
const INLINE_PATH = /(?:\/(?:Users|private|home|tmp|var|workspace|etc|root)(?:\/[^\s"'<>]*)*|[A-Za-z]:\\[^\s"'<>]*)/gi;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

export interface TodoUpdateInput {
  items: TodoItem[];
}

export interface TodoUpdateResult {
  items: TodoItem[];
  item_count: number;
}

const todoItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: MAX_TODO_ID_CHARS }),
  title: Type.String({ minLength: 1, maxLength: MAX_TODO_TITLE_CHARS }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
}, { additionalProperties: false });

export const todoUpdateParameters = Type.Object({
  items: Type.Array(todoItem, { maxItems: MAX_TODO_ITEMS }),
}, { additionalProperties: false });

/** Validate the runtime value again so direct tool calls cannot bypass bounds. */
export function normalizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value) || value.length > MAX_TODO_ITEMS) throw new Error("todo_update requires at most 32 items");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("todo_update items must be objects");
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !["id", "title", "status"].includes(key))) throw new Error("todo_update item has unsupported fields");
    if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > MAX_TODO_ID_CHARS || /[\\/]/u.test(raw.id)) throw new Error("todo_update item id is invalid");
    if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > MAX_TODO_TITLE_CHARS) throw new Error("todo_update item title is invalid");
    if (raw.status !== "pending" && raw.status !== "in_progress" && raw.status !== "completed") throw new Error("todo_update item status is invalid");
    if (ids.has(raw.id)) throw new Error("todo_update item ids must be unique");
    ids.add(raw.id);
    const title = raw.title.replace(INLINE_SECRET, "[内容已隐藏]").replace(INLINE_PATH, "[路径已隐藏]");
    return { id: raw.id, title, status: raw.status };
  });
}

export function createTodoUpdateTool(): ToolDefinition<typeof todoUpdateParameters, TodoUpdateResult> {
  return defineTool({
    name: TODO_UPDATE_TOOL_NAME,
    label: "Update todo list",
    description: "Replace the bounded local todo list for the current response.",
    promptSnippet: "todo_update(items)",
    parameters: todoUpdateParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      try {
        const items = normalizeTodoItems((params as TodoUpdateInput).items);
        const result: TodoUpdateResult = { items, item_count: items.length };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : "todo_update input is invalid" }],
          details: undefined,
          isError: true,
        };
      }
    },
  });
}
