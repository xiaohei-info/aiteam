import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConversationFailureStore } from "./conversation-failures.js";

test("conversation failures keep one latest row per participant until it runs again", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const failures = new ConversationFailureStore(db);
    const at = Date.UTC(2026, 10, 4, 8, 0, 0);
    failures.record({ conversationId: "c1", workId: "w1", errorCode: "execution_failed", errorMessage: "first", failedAt: at });
    failures.record({ conversationId: "c1", workId: "w2", errorCode: "execution_failed", errorMessage: "x".repeat(500), failedAt: at + 1 });
    failures.record({ conversationId: "c1", employeeId: "pm", errorCode: "manager_unavailable", errorMessage: "group", failedAt: at + 2 });
    failures.record({ conversationId: "c2", errorCode: "execution_failed", errorMessage: "other", failedAt: at });

    const listed = failures.list("c1");
    assert.deepEqual(listed.map((item) => [item.employee_id, item.work_id]), [[null, "w2"], ["pm", null]]);
    assert.equal(listed[0]!.error_message.length, 240);
    assert.equal(listed[1]!.failed_at, new Date(at + 2).toISOString());

    failures.clear("c1");
    assert.deepEqual(failures.list("c1").map((item) => item.employee_id), ["pm"]);
    failures.deleteConversation("c1");
    assert.deepEqual(failures.list("c1"), []);
    assert.equal(failures.list("c2").length, 1);
  } finally {
    db.close();
  }
});
