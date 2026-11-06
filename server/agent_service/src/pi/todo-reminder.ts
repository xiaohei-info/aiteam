import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TODO_UPDATE_TOOL_NAME, type TodoItem } from "../tools/todo.js";

type AgentMessage = ContextEvent["messages"][number];

/** Tool calls without a checklist update before the model is reminded. */
export const TODO_REMINDER_AFTER_TOOL_CALLS = 8;

const REMINDER = "[Platform reminder, not from the user] The checklist the user sees has not changed for a while. If any item has started or finished, call todo_update now with the current status of every item. Do not mention this reminder.";

function checklistItems(message: AgentMessage): TodoItem[] | undefined {
  if (message.role !== "toolResult" || message.toolName !== TODO_UPDATE_TOOL_NAME || message.isError) return undefined;
  const items = (message.details as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items as TodoItem[] : undefined;
}

/**
 * The messages with a reminder added to the newest tool result when the current run's checklist has
 * unfinished items and has gone unchanged for too many tool calls; undefined when none is due. It
 * lives only in the model's view of this call, so it is neither stored nor shown to the user.
 */
export function withTodoReminder(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
  const newest = messages[messages.length - 1];
  if (newest?.role !== "toolResult") return undefined;
  let toolCalls = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "custom") return undefined; // No checklist in this run.
    if (message.role !== "toolResult") continue;
    const items = checklistItems(message);
    if (!items) { toolCalls += 1; continue; }
    if (toolCalls < TODO_REMINDER_AFTER_TOOL_CALLS || items.every((item) => item.status === "completed")) return undefined;
    return [...messages.slice(0, -1), { ...newest, content: [...newest.content, { type: "text", text: REMINDER }] }];
  }
  return undefined;
}

/**
 * Whether the snapshot grants todo_update, by the same rule as the session's tool list: no
 * explicit allowed_tools means the default set, which includes it.
 */
export function todoUpdateAllowed(toolPolicy: unknown): boolean {
  const allowed = toolPolicy && typeof toolPolicy === "object" ? (toolPolicy as Record<string, unknown>).allowed_tools : undefined;
  const names = Array.isArray(allowed) ? allowed.filter((name): name is string => typeof name === "string") : [];
  return names.length === 0 || names.includes(TODO_UPDATE_TOOL_NAME);
}

export const todoReminderExtension: ExtensionFactory = (pi) => {
  pi.on("context", (event) => {
    const messages = withTodoReminder(event.messages);
    return messages ? { messages } : undefined;
  });
};
