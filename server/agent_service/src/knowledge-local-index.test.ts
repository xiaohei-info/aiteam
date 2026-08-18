import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSqliteStore, type KnowledgeArtifact } from "./storage/sqlite.js";
import { SqliteKnowledgeIndex } from "./tools/knowledge.js";

const caller = { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] };
const artifact = (overrides: Partial<KnowledgeArtifact> = {}): KnowledgeArtifact => ({
  tenant_id: "tenant-a", member_id: "member-a", employee_id: "employee-a", knowledge_space_id: "space-a",
  document_id: "doc-a", artifact_version: "v1", source_hash: "hash-a", citation_id: "cite-a", chunk_index: 0,
  title: "Handbook", source: { type: "file", name: "handbook.txt", mime_type: "text/plain" },
  content: "offline policy handbook",
  ...overrides,
});

test("SQLite knowledge index searches and gets offline with exact ownership/ref closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-knowledge-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    store.replaceKnowledgeArtifacts([artifact(), artifact({ citation_id: "cite-b", knowledge_space_id: "space-b", content: "other tenant data" })], { tenantId: "tenant-a", memberId: "member-a" });
    const index = new SqliteKnowledgeIndex(store);
    const found = await index.search(caller, "employee-a", ["space-a"], "offline policy", 10);
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0]?.citation_id, "cite-a");
    assert.equal((await index.get(caller, "employee-a", ["space-a"], "cite-a")).citation?.content, "offline policy handbook");
    assert.equal((await index.get(caller, "employee-a", ["space-b"], "cite-a")).citation, null);
    assert.equal((await index.get({ ...caller, tenantId: "tenant-b" }, "employee-a", ["space-a"], "cite-a")).citation, null);
    store.replaceKnowledgeArtifacts([], { tenantId: "tenant-a", memberId: "member-a" });
    assert.equal((await index.search(caller, "employee-a", ["space-a"], "offline", 10)).items.length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
