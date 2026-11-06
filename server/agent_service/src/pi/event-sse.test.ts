import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { classifyToolKind, failureText, MAX_FAILURE_MESSAGE_CHARS, MAX_MESSAGE_TEXT_CHARS, serializePiEntry, serializePiEvent } from "./event-sse.js";
import { historyEntryRef } from "./session-history.js";

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

test("persisted entries use the same redacted boundary as live events", () => {
  const entry = serializePiEntry({
    id: "entry-1",
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "read /private/file with api_key=hidden-value" }],
      usage: { input: 100, provider: "secret" },
    },
    details: { token: "hidden-token", safe: "visible" },
  });
  assert.equal(entry?.id, "entry-1");
  assert(!JSON.stringify(entry).includes("hidden-token"));
  // Message bodies keep the paths the assistant wrote; credentials stay redacted.
  assert(JSON.stringify(entry).includes("/private/file"));
  assert(!JSON.stringify(entry).includes("hidden-value"));
  assert(!JSON.stringify(entry).includes("provider"));
  assert.equal((entry?.message as { role?: string } | undefined)?.role, "assistant");
});

test("failure reasons keep paths for developers, hide credentials and shorten only the home directory", () => {
  assert.equal(failureText("Cannot find module '/Users/edy/app/a.js' imported from /Users/edy/app", "/Users/edy"),
    "Cannot find module '~/app/a.js' imported from ~/app");
  // A home that is a prefix of another account's directory is left alone.
  assert.equal(failureText("see /Users/edy2/app", "/Users/edy"), "see /Users/edy2/app");
  assert.equal(failureText("see C:\\Users\\edy\\app", "C:\\Users\\edy\\"), "see ~\\app");
  assert.equal(failureText("401 api_key=hidden-value at /opt/x", "/Users/edy"), "401 [内容已隐藏] at /opt/x");
  assert.equal(failureText("x".repeat(MAX_FAILURE_MESSAGE_CHARS + 50), "/Users/edy").length, MAX_FAILURE_MESSAGE_CHARS);
});

test("failed model calls keep a credential-free, bounded error on live and persisted assistant messages", () => {
  const failed = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: `Cannot find module '/Users/someone/app/openai-completions.js' from ${homedir()}/fred api_key=hidden-value ${"x".repeat(1200)}`,
    provider: "secret-provider",
  };
  const live = serializePiEvent({ type: "message_end", message: failed } as never)?.message as Record<string, unknown>;
  const stored = serializePiEntry({ id: "entry-error", type: "message", message: failed })?.message as Record<string, unknown>;
  for (const message of [live, stored]) {
    assert.equal(message.stopReason, "error");
    const error = message.errorMessage as string;
    assert.match(error, /^Cannot find module '\/Users\/someone\/app\/openai-completions\.js' from ~\/fred /);
    assert.equal(error.length, MAX_FAILURE_MESSAGE_CHARS);
    assert(!error.includes(homedir()));
    assert(!error.includes("hidden-value"));
    assert(!JSON.stringify(message).includes("secret-provider"));
  }
  // Only a failed call carries an error; unknown stop reasons and non-assistant roles carry neither.
  const done = serializePiEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", errorMessage: "stale" } } as never)?.message;
  assert.deepEqual(done, { role: "assistant", content: [], stopReason: "stop" });
  const odd = serializePiEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "provider_internal" } } as never)?.message;
  assert.deepEqual(odd, { role: "assistant", content: [] });
  const user = serializePiEvent({ type: "message_end", message: { role: "user", content: "hi", stopReason: "error", errorMessage: "x" } } as never)?.message;
  assert.deepEqual(user, { role: "user", content: "hi" });
});

test("generated entry_ref hashes survive serialization even when they look like a key prefix", () => {
  // sha256 base64url can contain `rk-`/`sk-`/`pk-`; credential redaction used to rewrite those refs.
  const prefixed: string[] = [];
  for (let i = 0; prefixed.length < 3; i++) {
    const ref = historyEntryRef("c1", "e1", `entry-${i}`);
    if (/(?:sk|pk|rk)-/i.test(ref)) prefixed.push(ref);
  }
  for (const ref of [...prefixed, "entry_v1_qrk-F-hXrM1ftGnv7VRTwDesBE-hPa30TVk4GbbfMB4"]) {
    assert.equal(serializePiEntry({ id: "a1", type: "message", entry_ref: ref })?.entry_ref, ref);
  }
  for (const invalid of ["entry_v1_short", "Bearer sk-live-credential", `entry_v1_${"a".repeat(43)} extra`, 42]) {
    assert.equal(serializePiEntry({ id: "a1", type: "message", entry_ref: invalid })?.entry_ref, undefined, String(invalid));
  }
});

test("Pi tool classification covers memory, RAG, and todo tools", () => {
  assert.equal(classifyToolKind("hindsight_recall"), "memory");
  assert.equal(classifyToolKind("knowledge_search"), "rag");
  assert.equal(classifyToolKind("todo_update"), "todo");
  assert.equal(classifyToolKind("bash"), undefined);
});

test("Pi SSE serializer preserves message timestamps for durable/live deduplication", () => {
  const event = serializePiEvent({
    type: "message_update",
    message: { role: "assistant", timestamp: 42, content: [{ type: "thinking", thinking: "working" }] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
  } as never);
  assert.equal((event?.message as { timestamp?: number } | undefined)?.timestamp, 42);
});

test("Pi SSE serializer keeps redacted arguments for ordinary persisted tool calls", () => {
  const event = serializePiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-bash",
        name: "bash",
        arguments: { command: "printf 'visible' && cat /private/secret.txt", token: "hidden-token" },
      }],
    },
  } as never);
  assert.deepEqual(event?.message, {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-bash",
      name: "bash",
      arguments: { command: "printf 'visible' && cat [路径已隐藏]", },
    }],
  });
  assert(!JSON.stringify(event).includes("hidden-token"));
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

test("execution work ID rides persisted entries, survives bounding, and is never taken from runtime events", () => {
  const id = "5af79698-7047-4c5e-8c3f-4f9bdba806a9";
  const entry = serializePiEntry({ id: "entry", type: "message", work_id: id, message: { role: "assistant", content: "done" } });
  assert.equal(entry?.work_id, id);
  // The same field is live SSE metadata; runtime-supplied values never pass through.
  assert.equal(serializePiEvent({ type: "agent_settled", work_id: "runtime-forged" } as never)?.work_id, undefined);
  // Oversized entries collapse to the minimal shape, which must still carry the grouping key.
  const thinking = Array.from({ length: 8 }, () => ({ type: "thinking", thinking: "x".repeat(4_000) }));
  const bounded = serializePiEntry({ id: "entry", type: "message", work_id: id, message: { role: "assistant", content: thinking } });
  assert.equal(bounded?.message, undefined);
  assert.equal(bounded?.work_id, id);
});

test("user and assistant message bodies are returned in full; the cap only stops runaway text", () => {
  // A long Chinese report is ~3 bytes per character, far past the 24KB event budget.
  const report = `开头${"热门项目总结。".repeat(9_000)}结尾 /Users/edy/report.md api_key=sk-secret`;
  const expected = report.replace("api_key=sk-secret", "[内容已隐藏]");
  for (const role of ["assistant", "user"] as const) {
    const entry = serializePiEntry({ id: "e", type: "message", message: { role, content: [{ type: "text", text: report }] } });
    assert.deepEqual((entry?.message as { content: unknown[] }).content, [{ type: "text", text: expected }], role);
  }
  const plain = serializePiEntry({ id: "e", type: "message", message: { role: "assistant", content: report } });
  assert.equal((plain?.message as { content: string }).content, expected);
  const end = serializePiEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: report }] } } as never);
  assert.deepEqual((end?.message as { content: unknown[] }).content, [{ type: "text", text: expected }]);

  const runaway = serializePiEntry({ id: "e", type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(MAX_MESSAGE_TEXT_CHARS + 10) }] } });
  const [cut] = (runaway?.message as { content: Array<{ text: string; truncated?: boolean }> }).content;
  assert.equal(cut.text.length, MAX_MESSAGE_TEXT_CHARS);
  assert.equal(cut.text.endsWith("…"), true);
  assert.equal(cut.truncated, true);

  // Thinking and tool output keep the 4000-character diagnostic cap.
  const other = serializePiEntry({ id: "e", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(5_000) }] } });
  assert.equal((other?.message as { content: Array<{ thinking: string }> }).content[0].thinking.length, 4_000);
  const tool = serializePiEntry({ id: "e", type: "message", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "o".repeat(5_000) }] } });
  assert.deepEqual((tool?.message as { content: unknown[] }).content, [{ type: "text", text: `${"o".repeat(3_999)}…` }]);
});

test("live message_update snapshots stay short and never push the delta out of the event", () => {
  const event = serializePiEvent({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(4_000) }, { type: "text", text: "字".repeat(8_000) }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "字" },
  } as never);
  const [, text] = (event?.message as { content: Array<{ text?: string; truncated?: boolean }> }).content;
  assert.equal(text.text?.length, 4_000);
  assert.equal(text.truncated, true);
  assert.deepEqual(event?.assistantMessageEvent, { type: "text_delta", contentIndex: 1, delta: "字" });
});

test("approval_required summary keeps full file paths but still hides credentials and is bounded", () => {
  const event = serializePiEvent({
    type: "approval_required",
    toolName: "bash",
    summary: "cp '/Users/chendian/a.txt' '/Users/chendian/b.txt' token=unsafe-token",
  } as never);
  assert.equal(event?.summary, "cp '/Users/chendian/a.txt' '/Users/chendian/b.txt' [内容已隐藏]");

  const long = serializePiEvent({ type: "approval_required", toolName: "bash", summary: "x".repeat(5_000) } as never);
  assert.equal(typeof long?.summary, "string");
  assert.equal((long?.summary as string).length, 4_000);
  assert.equal((long?.summary as string).endsWith("…"), true);

  assert.equal(serializePiEvent({ type: "approval_required", toolName: "bash", summary: 42 } as never)?.summary, undefined);
});

test("assistant and user message text keeps file paths and Markdown links intact", () => {
  const body = "报告已生成：[月报.md](/Users/x/work/月报.md)，原件见 file:///Users/x/a.pdf。token=unsafe-token";
  const expected = "报告已生成：[月报.md](/Users/x/work/月报.md)，原件见 file:///Users/x/a.pdf。[内容已隐藏]";
  const entry = serializePiEntry({ id: "m1", type: "message", message: { role: "assistant", content: [{ type: "text", text: body }] } });
  assert.deepEqual((entry?.message as { content: unknown }).content, [{ type: "text", text: expected }]);
  const user = serializePiEntry({ id: "m2", type: "message", message: { role: "user", content: body } });
  assert.equal((user?.message as { content: unknown }).content, expected);

  const delta = serializePiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "见 /tmp/out/result.csv" } } as never);
  assert.equal((delta?.assistantMessageEvent as { delta: string }).delta, "见 /tmp/out/result.csv");
});

test("thinking and tool output keep hiding paths without swallowing surrounding text", () => {
  const thinking = serializePiEntry({ id: "t1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "读取 /Users/x/a.txt。" }] } });
  assert.deepEqual((thinking?.message as { content: unknown }).content, [{ type: "thinking", thinking: "读取 [路径已隐藏]。" }]);

  const result = serializePiEntry({ id: "t2", type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "wrote (/tmp/out/a.txt), see [x](/var/log/x.log)." }] } });
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("/tmp/out/a.txt") && !serialized.includes("/var/log/x.log"));
  assert(serialized.includes("wrote ([路径已隐藏]), see [x]([路径已隐藏])."));
});

test("history entries expose only the context-reset custom marker with bounded data", () => {
  const marker = serializePiEntry({ id: "r1", type: "custom", customType: "aiteam_context_reset", data: { reset_id: "reset-1", message_count: 3, memory_saved: true, memory_reason: "saved", token: "hidden" } });
  assert.equal(marker?.customType, "aiteam_context_reset");
  assert.deepEqual(marker?.data, { reset_id: "reset-1", message_count: 3, memory_saved: true, memory_reason: "saved" });
  // Other extension custom entries stay opaque.
  const other = serializePiEntry({ id: "c1", type: "custom", customType: "other_extension", data: { note: "private" } });
  assert.deepEqual(other, { id: "c1", type: "custom" });
});

test("credential URL query parameters are hidden in live and persisted messages", () => {
  const url = "https://example.test/api?key=url-secret-1&page=2&access_token=url-secret-2#top";
  const signed = "https://bucket.example.test/a.png?X-Amz-Credential=url-secret-3&X-Amz-Signature=url-secret-4";
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: `401 from ${url}` };
  const answer = { role: "assistant", content: [{ type: "text", text: `图片在 ${signed} ，接口 ${url}` }], stopReason: "stop" };
  for (const message of [failed, answer]) {
    const live = serializePiEvent({ type: "message_end", message } as never);
    const stored = serializePiEntry({ id: `entry-${message.stopReason}`, type: "message", message });
    for (const serialized of [JSON.stringify(live), JSON.stringify(stored)]) {
      assert.doesNotMatch(serialized, /url-secret-\d/);
      // Only the values go: the host, path and harmless parameters stay readable.
      assert.match(serialized, /https:\/\/example\.test\/api\?key=\[内容已隐藏\]&page=2/);
    }
  }
  // A bare word "key" or a parameter that merely ends in "key" is not a credential.
  const plain = serializePiEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "sort key=name, https://example.test/?monkey=1" }], stopReason: "stop" } } as never);
  assert.match(JSON.stringify(plain), /sort key=name, https:\/\/example\.test\/\?monkey=1/);
});

test("credential URL parameters keep their name and the rest of the URL, live and persisted", () => {
  // Names that the plain-text rule also knows (api_key, token, secret …) must not be redacted twice.
  const names = ["api_key", "apikey", "api-key", "key", "token", "access_token", "refresh_token", "secret", "client_secret", "credential", "X-Amz-Credential", "X-Amz-Signature", "sig", "auth", "password_pwd"];
  for (const name of names) {
    const url = `https://example.test/v1/files?${name}=v-${name.length}x9&page=2#top`;
    const message = { role: "assistant", content: [{ type: "text", text: `see ${url} now` }], stopReason: "error", errorMessage: `401 from ${url}` };
    const live = serializePiEvent({ type: "message_end", message } as never)?.message as Record<string, unknown>;
    const stored = serializePiEntry({ id: `entry-${name}`, type: "message", message })?.message as Record<string, unknown>;
    const expected = `https://example.test/v1/files?${name}=[内容已隐藏]&page=2#top`;
    for (const serialized of [live, stored]) {
      assert.equal(serialized.errorMessage, `401 from ${expected}`, name);
      assert.deepEqual(serialized.content, [{ type: "text", text: `see ${expected} now` }], name);
    }
  }
  // The same names outside a URL are still hidden whole, as before.
  const plain = serializePiEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "api_key=abc123 token: xyz Bearer qwe" }], stopReason: "stop" } } as never)?.message as Record<string, unknown>;
  assert.deepEqual(plain.content, [{ type: "text", text: "[内容已隐藏] [内容已隐藏] [内容已隐藏]" }]);
});
