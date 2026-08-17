import assert from "node:assert/strict";
import { test } from "node:test";
import { serializePiEvent } from "./event-sse.js";

test("Pi SSE serializer allowlists events and removes credential/path fields", () => {
  const event = serializePiEvent({ type: "tool_execution_update", toolName: "read", path: "/private/data", authorization: "Bearer secret" } as never, { conversation_id: "conversation-1" });
  assert.deepEqual(event, { type: "tool_execution_update", toolName: "read", conversation_id: "conversation-1" });
  assert.equal(serializePiEvent({ type: "unknown_internal_event", body: "secret" } as never), undefined);
});
