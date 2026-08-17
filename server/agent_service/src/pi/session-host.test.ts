import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";

test("SessionHost persists a Pi session and replays entries", async () => {
  const fixture = await createFixture();
  try {
    fixture.faux.setResponses([fauxAssistantMessage("hello from pi")]);
    const events: string[] = [];
    const unsubscribe = await fixture.host.subscribe("conversation-1", (envelope) => {
      events.push(envelope.event.type);
    });

    const leafId = await fixture.host.prompt("conversation-1", "hello");
    assert(leafId);
    assert(events.includes("message_update"));
    assert(events.includes("agent_settled"));
    const entries = await fixture.host.entries("conversation-1");
    assert(entries.some((entry) => entry.type === "message"));
    unsubscribe();

    const replayed: string[] = [];
    await fixture.host.dispose();
    const reopenedHost = fixture.createHost();
    const unsubscribeReopened = await reopenedHost.subscribe("conversation-1", (envelope) => {
      replayed.push(envelope.event.type);
    });
    assert(replayed.includes("entry_appended"));
    unsubscribeReopened();
    await reopenedHost.dispose();
  } finally {
    await fixture.close();
  }
});

test("SessionHost aborts an active Pi prompt", async () => {
  const fixture = await createFixture();
  try {
    const slow = fauxProvider({
      api: "aiteam-slow-api",
      provider: "aiteam-slow",
      models: [{ id: "aiteam-slow-1", name: "AI Team Slow" }],
      tokensPerSecond: 50,
    });
    fixture.modelRuntime.registerNativeProvider(slow.provider);
    const slowHost = fixture.createHost(slow.getModel());
    const events: string[] = [];
    await slowHost.subscribe("conversation-2", (envelope) => events.push(envelope.event.type));
    slow.setResponses([fauxAssistantMessage("slow ".repeat(200))]);

    const pending = slowHost.prompt("conversation-2", "start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await slowHost.abort("conversation-2"), true);
    await pending;
    assert(events.includes("agent_end"));
    assert.equal(slowHost.isPrompting("conversation-2"), false);
    await slowHost.dispose();
  } finally {
    await fixture.close();
  }
});
