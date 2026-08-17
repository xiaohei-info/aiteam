import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentHttpServer } from "./server.js";
import { createFixture } from "../test-fixture.js";

async function waitForEntries(url: string, token: string): Promise<unknown[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: token } });
    const body = (await response.json()) as { data: { entries: unknown[] } };
    if (body.data.entries.length > 0) return body.data.entries;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Pi session entries");
}

test("Agent HTTP prompt accepts an idempotent Pi prompt", async () => {
  const fixture = await createFixture();
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: (request) => {
      assert.equal(request.headers.authorization, "Bearer test");
      return { callerId: "member-1" };
    },
  });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    fixture.faux.setResponses([fauxAssistantMessage("ok")]);
    const eventsAbort = new AbortController();
    const eventsResponse = await fetch(`${base}/api/agent/conversations/c1/events`, {
      headers: { Authorization: "Bearer test" },
      signal: eventsAbort.signal,
    });
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert(eventsResponse.body);
    const reader = eventsResponse.body.getReader();
    const decoder = new TextDecoder();
    const connected = await reader.read();
    assert(decoder.decode(connected.value).includes(": connected"));

    const prompt = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(prompt.status, 202);
    const accepted = (await prompt.json()) as { data: { accepted: boolean } };
    assert.equal(accepted.data.accepted, true);

    let streamed = "";
    for (let attempt = 0; attempt < 10 && !streamed.includes('"type":"message_update"'); attempt += 1) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1000)),
      ]);
      if (next.done) break;
      streamed += decoder.decode(next.value);
    }
    assert(streamed.includes("event: pi"));
    assert(streamed.includes('"type":"message_update"'));
    eventsAbort.abort();
    await reader.cancel().catch(() => undefined);

    const entries = await waitForEntries(`${base}/api/agent/conversations/c1/entries`, "Bearer test");
    assert(entries.length > 0);

    const duplicate = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(duplicate.status, 202);

    const conflict = await fetch(`${base}/api/agent/conversations/c1/prompt`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ text: "different" }),
    });
    assert.equal(conflict.status, 409);
    const conflictBody = (await conflict.json()) as { code: string };
    assert.equal(conflictBody.code, "idempotency_conflict");
    assert.equal(fixture.faux.state.callCount, 1, "duplicate idempotency key does not prompt twice");
  } finally {
    await http.close();
    await fixture.close();
  }
});
