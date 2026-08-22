import assert from "node:assert/strict";
import { test } from "node:test";
import { createRagMcpFactory, ragMcpUrl, ragToolNames } from "./rag-mcp.js";

test("RAG MCP is enabled only by the snapshot allowlist and fixed endpoint", () => {
  assert.equal(ragMcpUrl(undefined), undefined);
  assert.equal(ragMcpUrl("http://other.test"), undefined);
  process.env.AITEAM_RAG_MCP_URL = "http://manager.test/api/manager/rag/mcp";
  try {
    assert.equal(ragMcpUrl("http://manager.test/control"), "http://manager.test/api/manager/rag/mcp");
    assert.deepEqual(ragToolNames({ tool_policy: { allowed_tools: ["knowledge_search"] } }, "http://manager.test"), ["knowledge_search"]);
    assert.deepEqual(ragToolNames({ tool_policy: { allowed_tools: ["knowledge_search", "knowledge_get"] } }, "http://manager.test"), ["knowledge_search", "knowledge_get"]);
    assert.deepEqual(ragToolNames({ tool_policy: { allowed_tools: ["knowledge_get"] } }, "http://manager.test"), []);
    assert.deepEqual(ragToolNames({ tool_policy: { allowed_tools: ["knowledge_search"] } }), []);
    assert.equal(createRagMcpFactory({ caller: { callerId: "member" }, employeeId: "employee", snapshot: {} } as never, "http://manager.test"), undefined);
  } finally {
    delete process.env.AITEAM_RAG_MCP_URL;
  }
});

test("RAG MCP is the only enterprise knowledge tool factory", () => {
  process.env.AITEAM_RAG_MCP_URL = "http://manager.test/api/manager/rag/mcp";
  try {
    const registered: string[] = [];
    const factory = createRagMcpFactory({ caller: { callerId: "member", accessToken: "token" }, employeeId: "employee", snapshot: { tool_policy: { allowed_tools: ["knowledge_search", "knowledge_get", "unknown"] } } } as never, "http://manager.test");
    assert(factory);
    factory({ registerTool: (tool: { name: string }) => registered.push(tool.name), on: () => undefined } as never);
    assert.deepEqual(registered, ["knowledge_search", "knowledge_get"]);
  } finally {
    delete process.env.AITEAM_RAG_MCP_URL;
  }
});

test("RAG MCP rejects a mismatched origin, path, query, or fragment", () => {
  const manager = "https://manager.test:9443";
  for (const configured of [
    "https://other.test:9443/api/manager/rag/mcp",
    "https://manager.test:9443/api/manager/rag/other",
    "https://manager.test:9443/api/manager/rag/mcp?x=1",
    "https://manager.test:9443/api/manager/rag/mcp#fragment",
  ]) {
    process.env.AITEAM_RAG_MCP_URL = configured;
    assert.equal(ragMcpUrl(manager), undefined);
  }
  delete process.env.AITEAM_RAG_MCP_URL;
});
