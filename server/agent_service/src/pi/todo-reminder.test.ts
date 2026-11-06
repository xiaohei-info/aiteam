import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { TODO_REMINDER_AFTER_TOOL_CALLS, todoUpdateAllowed, withTodoReminder } from "./todo-reminder.js";

type AgentMessage = ContextEvent["messages"][number];

const user = { role: "user", content: "go", timestamp: 1 } as AgentMessage;
function result(toolName: string, details?: unknown, isError = false): AgentMessage {
  return { role: "toolResult", toolCallId: "call", toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 } as AgentMessage;
}
const checklist = (status: string) => result("todo_update", { items: [{ id: "one", title: "One", status }], item_count: 1 });
const calls = (count: number) => Array.from({ length: count }, () => result("bash"));
const lastText = (messages: AgentMessage[] | undefined) => {
  const last = messages?.[messages.length - 1];
  return last?.role === "toolResult" ? last.content.map((part) => part.type === "text" ? part.text : "").join("|") : "";
};

test("the reminder is added to the newest tool result once the checklist has gone stale", () => {
  const input = [user, checklist("pending"), ...calls(TODO_REMINDER_AFTER_TOOL_CALLS)];
  const before = JSON.stringify(input);
  const output = withTodoReminder(input);
  assert.match(lastText(output), /^ok\|\[Platform reminder/);
  assert.equal(output?.length, input.length);
  assert.equal(JSON.stringify(input), before, "the stored messages stay untouched");
});

test("no reminder before the threshold, or right after an update", () => {
  assert.equal(withTodoReminder([user, checklist("pending"), ...calls(TODO_REMINDER_AFTER_TOOL_CALLS - 1)]), undefined);
  assert.equal(withTodoReminder([user, checklist("pending"), ...calls(20), checklist("in_progress")]), undefined);
});

test("no reminder without an unfinished checklist in the current run", () => {
  assert.equal(withTodoReminder([user, ...calls(20)]), undefined, "no checklist at all");
  assert.equal(withTodoReminder([user, checklist("completed"), ...calls(20)]), undefined, "everything is done");
  assert.equal(withTodoReminder([checklist("pending"), user, ...calls(20)]), undefined, "a previous run's checklist");
  assert.equal(withTodoReminder([user, checklist("pending"), ...calls(20), { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage]), undefined, "only after a tool result");
});

test("a rejected todo_update counts as a tool call, not an update", () => {
  const rejected = result("todo_update", undefined, true);
  assert.match(lastText(withTodoReminder([user, checklist("pending"), ...calls(TODO_REMINDER_AFTER_TOOL_CALLS - 1), rejected])), /Platform reminder/);
});

test("the reminder is only loaded for employees that may use todo_update", () => {
  assert.equal(todoUpdateAllowed(undefined), true, "the default tool set includes it");
  assert.equal(todoUpdateAllowed({ allowed_tools: [] }), true);
  assert.equal(todoUpdateAllowed({ allowed_tools: ["bash", "todo_update"] }), true);
  assert.equal(todoUpdateAllowed({ allowed_tools: ["hindsight_recall"] }), false);
});
