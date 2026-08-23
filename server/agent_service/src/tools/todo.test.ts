import assert from "node:assert/strict";
import { test } from "node:test";
import { createTodoUpdateTool, MAX_TODO_ITEMS, normalizeTodoItems } from "./todo.js";

test("todo_update validates a unique, bounded todo shape and returns a structured result", async () => {
  const tool = createTodoUpdateTool();
  const input = { items: [{ id: "one", title: "Do one", status: "in_progress" as const }] };
  assert.deepEqual(normalizeTodoItems(input.items), input.items);
  const safe = normalizeTodoItems([{ id: "safe", title: "open /private/secret.txt with api_key=secret", status: "pending" }]);
  assert.equal(safe[0]?.title, "open [路径已隐藏] with [内容已隐藏]");
  const result = await tool.execute("call-1", input, undefined, undefined, undefined as never);
  assert.deepEqual(result.details, { items: input.items, item_count: 1 });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? JSON.parse(result.content[0].text).item_count : undefined, 1);
});

test("todo_update rejects duplicates, unsupported fields, and oversized lists", () => {
  assert.throws(() => normalizeTodoItems([
    { id: "same", title: "one", status: "pending" },
    { id: "same", title: "two", status: "completed" },
  ]), /unique/);
  assert.throws(() => normalizeTodoItems([{ id: "one", title: "one", status: "pending", path: "/private" }]), /unsupported/);
  assert.throws(() => normalizeTodoItems(Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({ id: String(index), title: "item", status: "pending" }))), /at most/);
});
