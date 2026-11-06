import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TODO_UPDATE_TOOL_NAME, type TodoItem } from "../tools/todo.js";

/**
 * One hidden extra turn at the end of a run whose reply finished while the checklist the user sees
 * still has unfinished items: the model gets one chance to call todo_update, nothing else. The turn
 * belongs to the same run, but its text, thinking and errors are never shown and never decide the
 * run's result; only the checklist update is visible.
 */
export const TODO_RECONCILE_TYPE = "todo_reconcile";

export const TODO_RECONCILE_PROMPT = "[Platform check, not from the user] Your reply is finished, but the checklist the user sees still has unfinished items. Call todo_update once with the true final status of every item: completed for each item you finished, and keep pending or in_progress for anything you did not do. Do not write any text and do not call any other tool.";

export const TODO_RECONCILE_SKIPPED = "Skipped: only todo_update may run while the checklist is being closed.";

/** The checklist from the newest successful todo_update in these entries. */
export function latestChecklist(entries: readonly SessionEntry[]): TodoItem[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName !== TODO_UPDATE_TOOL_NAME || entry.message.isError) continue;
    const items = (entry.message.details as { items?: unknown } | undefined)?.items;
    if (Array.isArray(items)) return items as TodoItem[];
  }
  return undefined;
}

export function checklistUnfinished(entries: readonly SessionEntry[]): boolean {
  return latestChecklist(entries)?.some((item) => item.status !== "completed") ?? false;
}

/** Positions of the entries a reconcile turn wrote: after its prompt, until the next user message. */
export function reconcileEntryPositions(entries: readonly SessionEntry[]): Set<number> {
  const positions = new Set<number>();
  let inside = false;
  entries.forEach((entry, index) => {
    if (entry.type === "custom_message" && entry.customType === TODO_RECONCILE_TYPE) inside = true;
    else if (entry.type === "message" && entry.message.role === "user") inside = false;
    else if (inside) positions.add(index);
  });
  return positions;
}
