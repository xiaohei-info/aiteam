import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolKind, serializePiEvent } from "./event-sse.js";

test("Pi SSE serializer keeps bounded ordinary tool summaries without credential/path fields", () => {
  const event = serializePiEvent({
    type: "tool_execution_update",
    toolName: "read",
    args: { path: "/private/data", safe: "visible" },
    partialResult: { output: "partial", secret: "hidden" },
    authorization: "Bearer secret",
  } as never, { conversation_id: "conversation-1" });
  assert.deepEqual(event, {
    type: "tool_execution_update",
    conversation_id: "conversation-1",
    toolName: "read",
    args: { safe: "visible" },
    partialResult: { output: "partial" },
  });
  assert.equal(serializePiEvent({ type: "unknown_internal_event", body: "secret" } as never), undefined);
});

test("Pi tool classification covers memory, RAG, and todo tools", () => {
  assert.equal(classifyToolKind("hindsight_recall"), "memory");
  assert.equal(classifyToolKind("knowledge_search"), "rag");
  assert.equal(classifyToolKind("todo_update"), "todo");
  assert.equal(classifyToolKind("bash"), undefined);
});

test("Pi SSE serializer classifies bounded tool metadata without forwarding raw runtime data", () => {
  const event = serializePiEvent({
    type: "tool_execution_end",
    toolCallId: "call-rag",
    toolName: "knowledge_search",
    result: {
      content: [{ type: "text", text: JSON.stringify({ citation_id: "citation:space:doc:chunk", title: "Guide", text: "bounded excerpt", provider: "raw-provider" }) }],
      details: { path: "/private/provider.json", api_key: "secret" },
    },
    isError: false,
  } as never, {
    conversation_id: "conversation-1",
    source_employee_id: "employee-2",
    source_employee_display_name: "Researcher",
  });
  assert.deepEqual(event, {
    type: "tool_execution_end",
    conversation_id: "conversation-1",
    source_employee_id: "employee-2",
    source_employee_display_name: "Researcher",
    toolCallId: "call-rag",
    toolName: "knowledge_search",
    tool_kind: "rag",
    result: { citation_id: "citation:space:doc:chunk", title: "Guide", text: "bounded excerpt" },
    isError: false,
  });
  assert(!JSON.stringify(event).includes("raw-provider"));
  assert(!JSON.stringify(event).includes("provider.json"));
  assert(!JSON.stringify(event).includes("secret"));
});

test("Pi SSE serializer bounds structured todo arguments and keeps thinking content bounded", () => {
  const event = serializePiEvent({
    type: "tool_execution_start",
    toolCallId: "call-todo",
    toolName: "todo_update",
    args: { items: [{ id: "todo-1", title: "finish", status: "pending", path: "/private/todo" }], token: "secret" },
  } as never);
  assert.deepEqual(event, {
    type: "tool_execution_start",
    toolCallId: "call-todo",
    toolName: "todo_update",
    tool_kind: "todo",
    args: { items: [{ id: "todo-1", title: "finish", status: "pending" }] },
  });
  const thinking = serializePiEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x".repeat(10_000), partial: { provider: "hidden" } },
  } as never);
  assert(thinking);
  assert.equal((thinking.assistantMessageEvent as { delta: string }).delta.length, 4_000);
  assert(!JSON.stringify(thinking).includes("hidden"));

  const redacted = serializePiEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspect workspace /root/private/file and api_key=sk-secret" },
  } as never);
  const delta = (redacted?.assistantMessageEvent as { delta: string }).delta;
  assert(delta.startsWith("Inspect workspace "));
  assert(delta.includes("[路径已隐藏]"));
  assert(delta.includes("[内容已隐藏]"));
  assert.notEqual(delta, "[内容已隐藏]");
});
