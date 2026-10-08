import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createFixture } from "../test-fixture.js";
import { createControlledResourceLoader } from "./resources.js";
import { appLogger, ApplicationLogger, makeRequestContext, observedFetch, requestContext } from "../observability.js";

test("background Pi executions share one trace across lifecycle and Manager calls without leaking context", async (t) => {
  const fixture = await createFixture();
  const lines: string[] = [];
  const logger = new ApplicationLogger(line => lines.push(line));
  t.mock.method(appLogger, "log", logger.log.bind(logger));
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const caller = { callerId: "member-1", userId: "member-1", tenantId };
  const call = observedFetch(async () => new Response("ok"));
  const host = fixture.createHost(undefined, undefined, () => {
    const loader = createControlledResourceLoader("test prompt");
    loader.reload = async () => { await call("https://manager.test/first"); await call("https://manager.test/second"); };
    return loader;
  });
  try {
    fixture.store.replaceProjections([
      { employee_id: "employee-1", tenant_id: tenantId, member_id: "member-1", version: "1", handle: "helper", display_name: "Helper", revoked: false, synced_at: new Date().toISOString() },
    ], [], [{ employee_id: "employee-1", tenant_id: tenantId, member_id: "member-1", version: "1", snapshot_version: "snap-1", display_name: "Helper", tool_policy: { allowed_tools: [] } }]);
    const traces: string[] = [];
    for (let index = 0; index < 3; index++) {
      const conversationId = `background-${index}`;
      fixture.store.createConversation({ id: conversationId, sessionFile: "", workspace: "", tenantId, memberId: "member-1", entryEmployeeId: "employee-1" });
      const before = lines.length;
      fixture.faux.setResponses([fauxAssistantMessage("done")]);
      const incoming = index === 2 ? makeRequestContext(undefined, undefined) : undefined;
      if (incoming) await requestContext.run(incoming, () => host.prompt(conversationId, "hello", undefined, caller));
      else await host.prompt(conversationId, "hello", undefined, caller);
      const records = lines.slice(before).map(line => JSON.parse(line));
      assert(records.some(record => record.event === "execution.started"));
      assert(records.some(record => record.event === "execution.finished"));
      assert.equal(records.filter(record => record.event === "dependency.completed").length, 2);
      const first = records[0];
      assert.match(first.trace_id ?? "", /^[0-9a-f]{32}$/);
      assert(records.every(record => record.trace_id === first.trace_id && record.request_id === first.request_id && record.tenant_id === tenantId));
      if (incoming) assert.equal(first.trace_id, incoming.trace_id);
      traces.push(first.trace_id);
      assert.equal(requestContext.getStore(), undefined);
    }
    assert.equal(new Set(traces).size, 3, "separate executions need separate traces");
    assert.doesNotMatch(lines.join(""), /hello|test prompt/);
  } finally { await host.dispose(); await fixture.close(); }
});
