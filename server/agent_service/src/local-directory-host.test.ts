import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NativeDirectoryHost } from "./local-directory-host.js";
import type { DirectoryResource } from "./storage/local-directories.js";

function sampleResource(overrides: Partial<DirectoryResource> = {}): DirectoryResource {
  return {
    directory_id: "dir-1",
    tenant_id: "tenant-1",
    member_id: "member-1",
    canonical_path: "/private/test/docs",
    display_name: "docs",
    root_identity: "1:10",
    revision: 1,
    created_at: "2026-10-12T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

test("NativeDirectoryHost fails closed on missing config, unsafe socket mode, bad token, replay, and identity mismatch", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS Unix socket acceptance only");
    return;
  }
  const missingHost = new NativeDirectoryHost(undefined, undefined);
  await assert.rejects(() => missingHost.status(), /authorization_unavailable/);

  const dir = await mkdtemp(join(tmpdir(), "aifred-host-test-"));
  await chmod(dir, 0o700);
  const socketPath = join(dir, "host.sock");
  const validToken = "secret-host-token";
  const pending = new Map<string, { tenant_id: string; member_id: string; used?: boolean }>();
  let server: Server | undefined;
  try {
    server = createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (!buffer.endsWith("\n")) return;
        const req = JSON.parse(buffer) as Record<string, string>;
        if (req.token !== validToken) {
          conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
          return;
        }
        if (req.operation === "status") {
          conn.end(`${JSON.stringify({ data: { epoch: "ep-1", platform: "darwin", formats: ["txt", "md"] } })}\n`);
          return;
        }
        if (req.operation === "challenge") {
          const id = `chal-${pending.size + 1}`;
          pending.set(id, { tenant_id: req.tenant_id!, member_id: req.member_id! });
          conn.end(`${JSON.stringify({ data: { challenge: id } })}\n`);
          return;
        }
        if (req.operation === "consume") {
          const record = pending.get(req.ticket ?? "");
          if (!record || record.used) {
            conn.end(`${JSON.stringify({ error: "citation_expired" })}\n`);
            return;
          }
          record.used = true;
          if (record.tenant_id !== req.tenant_id || record.member_id !== req.member_id) {
            conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
            return;
          }
          conn.end(`${JSON.stringify({
            data: { canonical_path: "/private/test/docs", display_name: "docs", root_identity: "1:10" },
          })}\n`);
          return;
        }
        if (req.operation === "list") {
          conn.end(`${JSON.stringify({
            data: { authority: "ep-1:1", entries: [{ name: "../escape.txt", directory: false }], partial: false },
          })}\n`);
          return;
        }
        conn.end(`${JSON.stringify({ error: "unsupported_operation" })}\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    // World/group-readable socket must be rejected before connecting.
    await chmod(socketPath, 0o644);
    const host = new NativeDirectoryHost(socketPath, validToken);
    await assert.rejects(() => host.status(), /authorization_unavailable/);

    await chmod(socketPath, 0o600);
    await host.status();

    const wrongTokenHost = new NativeDirectoryHost(socketPath, "wrong-token");
    await assert.rejects(() => wrongTokenHost.status(), /unauthorized/);

    const ownerA = { tenantId: "tenant-a", memberId: "member-a" };
    const ownerB = { tenantId: "tenant-a", memberId: "member-b" };
    const ticket = await host.challenge(ownerA);
    await assert.rejects(() => host.consume(ownerB, ticket), /unauthorized/);

    const ticket2 = await host.challenge(ownerA);
    const consumed = await host.consume(ownerA, ticket2);
    assert.equal(consumed.display_name, "docs");
    await assert.rejects(() => host.consume(ownerA, ticket2), /citation_expired/);

    // Traversal entry names from a broken host payload must be rejected.
    await assert.rejects(() => host.list(sampleResource(), ""), /authorization_unavailable/);
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    await rm(dir, { recursive: true, force: true });
  }
});
