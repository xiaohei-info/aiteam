import assert from "node:assert/strict";
import { test } from "node:test";
import { createKnowledgeTools, type KnowledgeToolContext } from "./knowledge.js";
import type { ManagerClient } from "../manager-client.js";
import { createMemoryTools } from "./memory.js";

const caller = { callerId: "member-1", userId: "member-1", tenantId: "tenant-1", accessToken: "jwt" };

test("custom tools bind employee and authorized knowledge refs outside model parameters", async () => {
  const calls: unknown[][] = [];
  const manager = {
    memoryRecall: async (...args: unknown[]) => (calls.push(args), { memories: [] }),
    memoryRetain: async (...args: unknown[]) => (calls.push(args), { id: "m1" }),
  };
  const localIndex = {
    search: async (...args: unknown[]) => (calls.push(args), { citations: [] }),
    get: async (...args: unknown[]) => (calls.push(args), { citation: "c1" }),
  };
  const memory = createMemoryTools({ caller, employeeId: "employee-1", managerClient: manager as ManagerClient });
  const knowledge = createKnowledgeTools({ caller, employeeId: "employee-1", knowledgeRefs: ["set-authorized"], localKnowledgeIndex: localIndex });

  assert.deepEqual(Object.keys((knowledge[0].parameters as { properties: Record<string, unknown> }).properties), ["query", "limit"]);
  assert.deepEqual(Object.keys((knowledge[1].parameters as { properties: Record<string, unknown> }).properties), ["citation_id"]);
  await knowledge[0].execute("call-1", { query: "q", limit: 2 }, undefined, undefined, {} as never);
  await knowledge[1].execute("call-2", { citation_id: "citation-1" }, undefined, undefined, {} as never);
  await memory[1].execute("call-3", { content: "safe", metadata: { source: "test", api_key: "secret" } }, undefined, undefined, {} as never);

  assert.deepEqual(calls[0], [caller, "employee-1", ["set-authorized"], "q", 2]);
  assert.deepEqual(calls[1], [caller, "employee-1", ["set-authorized"], "citation-1"]);
  assert.deepEqual(calls[2], [caller, "employee-1", "safe", { source: "test" }]);
});

test("knowledge tools never invoke Manager and fail closed without a local index", async () => {
  let remoteCalls = 0;
  const manager = {};
  const tools = createKnowledgeTools({ caller, employeeId: "employee-1", knowledgeRefs: ["set-authorized"], managerClient: manager } as unknown as KnowledgeToolContext);

  const search = await tools[0].execute("call-1", { query: "q", limit: 1 }, undefined, undefined, {} as never);
  const get = await tools[1].execute("call-2", { citation_id: "citation-1" }, undefined, undefined, {} as never);

  assert.equal(remoteCalls, 0);
  assert.equal("isError" in search && search.isError, true);
  assert.equal("isError" in get && get.isError, true);
  assert.match(search.content[0].type === "text" ? search.content[0].text : "", /no remote artifact was read/);
});

test("custom tools explicitly degrade when Manager is unavailable", async () => {
  const tools = createMemoryTools({ caller, employeeId: "employee-1" });
  const result = await tools[0].execute("call-1", { query: "q", limit: 1 }, undefined, undefined, {} as never);
  assert.equal("isError" in result && result.isError, true);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /local Pi Session only/);
});
