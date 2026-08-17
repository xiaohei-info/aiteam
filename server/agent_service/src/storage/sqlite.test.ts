import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentSqliteStore } from "./sqlite.js";

test("projection ownership schema migrates legacy local databases additively", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-schema-migration-test-"));
  const path = join(root, "agent.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE loaded_employee_projection (employee_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, version TEXT NOT NULL, projection_json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL);
    CREATE TABLE loaded_solution_projection (solution_instance_id TEXT PRIMARY KEY, version TEXT NOT NULL, projection_json TEXT NOT NULL, synced_at TEXT NOT NULL);
    CREATE TABLE frozen_snapshot (employee_id TEXT PRIMARY KEY, snapshot_version TEXT NOT NULL, version TEXT NOT NULL, projection_json TEXT NOT NULL, synced_at TEXT NOT NULL);
    CREATE TABLE usage_summary_outbox (summary_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, claim_token TEXT, claimed_at TEXT);
  `);
  legacy.prepare("INSERT INTO loaded_employee_projection VALUES (?, ?, ?, ?, 0, ?)").run("old", "tenant-1", "1", JSON.stringify({ employee_id: "old", tenant_id: "tenant-1" }), new Date().toISOString());
  legacy.prepare("INSERT INTO frozen_snapshot VALUES (?, ?, ?, ?, ?)").run("old", "snap", "1", JSON.stringify({ employee_id: "old", tenant_id: "tenant-1" }), new Date().toISOString());
  legacy.close();
  const store = new AgentSqliteStore(path);
  try {
    assert.equal(store.listLoadedExperts("tenant-1", "member-1").length, 1, "legacy rows remain readable for backward-compatible fixtures");
    assert.equal((store.db.prepare("PRAGMA table_info(loaded_employee_projection)").all() as { name: string }[]).some((column) => column.name === "member_id"), true);
    assert.equal((store.db.prepare("PRAGMA table_info(usage_summary_outbox)").all() as { name: string }[]).some((column) => column.name === "member_id"), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite receipts never replay expired or unknown Pi prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-receipt-test-"));
  const store = new AgentSqliteStore(join(root, "agent.sqlite"));
  try {
    const first = store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f", leaseMs: 0 });
    assert.equal(first.isNew, true);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" }), /unknown execution state/);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "f" }), /unknown execution state/);
    assert.throws(() => store.reservePrompt({ conversationId: "c", callerId: "u", key: "k", fingerprint: "different" }), /different request/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
