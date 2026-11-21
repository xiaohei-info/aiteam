import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyPairKeyObjectResult } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, renameSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { canonicalSignedSkillPackageBytes, SkillCache, SkillVerificationError, skillRefsForSnapshot, skillSigningVerificationForSnapshot, type SkillSigningKeyMetadata, verifySignedSkillPackage } from "./skills.js";
import { createControlledResourceLoader } from "./pi/resources.js";
import { AgentHttpServer } from "./http/server.js";
import { createFixture } from "./test-fixture.js";

const sortJson = (value: unknown): unknown => Array.isArray(value) ? value.map(sortJson) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sortJson(v)])) : value;
const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
function signed(key: KeyPairKeyObjectResult, skillId = "review", keyId = "skill-key-1", tenantId = "tenant-a", memberId = "member-a") {
  const content = "---\nname: review\ndescription: Review text\n---\n# Review\n";
  const file = { path: "SKILL.md", content, content_hash: sha16(content) };
  const pkg = { skill_id: skillId, version: "1", content_hash: sha16(JSON.stringify([[file.path, file.content]])), display_name: "Review", description: "", files: [file] };
  const bytes = canonicalSignedSkillPackageBytes(pkg, tenantId, memberId);
  return { package: pkg, tenant_id: tenantId, member_id: memberId, key_id: keyId, algorithm: "Ed25519" as const, signature: sign(null, bytes, key.privateKey).toString("base64") };
}
const verification = (publicKey: string) => ({ publicKey, keyId: "skill-key-1" });
const metadata = (key: KeyPairKeyObjectResult, keyId: string, status: SkillSigningKeyMetadata["status"] = "current", extra: Partial<SkillSigningKeyMetadata> = {}): SkillSigningKeyMetadata => ({
  key_id: keyId,
  public_key: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  algorithm: "Ed25519",
  status,
  ...extra,
});

test("Python-compatible package hash sorts mixed-case reference paths", () => {
  const key = generateKeyPairSync("ed25519");
  const content = [
    { path: "references/a.md", content: "a\n", content_hash: sha16("a\n") },
    { path: "SKILL.md", content: "# Review\n", content_hash: sha16("# Review\n") },
    { path: "references/B.md", content: "B\n", content_hash: sha16("B\n") },
  ];
  const pkg = { skill_id: "review", version: "mixed", content_hash: "24eacde1fda51f39", display_name: "Review", description: "", files: content };
  const bytes = canonicalSignedSkillPackageBytes(pkg, "tenant-a", "member-a");
  const envelope = { package: pkg, tenant_id: "tenant-a", member_id: "member-a", key_id: "skill-key-1", algorithm: "Ed25519" as const, signature: sign(null, bytes, key.privateKey).toString("base64") };
  assert.equal(verifySignedSkillPackage(envelope, { publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"), keyId: "skill-key-1" }).package.content_hash, "24eacde1fda51f39");
});

test("rotation overlap selects envelope key_id and rejects revoked or unknown keys", () => {
  const current = generateKeyPairSync("ed25519");
  const next = generateKeyPairSync("ed25519");
  const unknown = generateKeyPairSync("ed25519");
  const keys = [metadata(current, "skill-current"), metadata(next, "skill-next", "next")];
  assert.equal(verifySignedSkillPackage(signed(current, "review", "skill-current"), { publicKeys: keys }).key_id, "skill-current");
  assert.equal(verifySignedSkillPackage(signed(next, "review", "skill-next"), { publicKeys: keys }).key_id, "skill-next");
  assert.throws(() => verifySignedSkillPackage(signed(unknown, "review", "skill-unknown"), { publicKeys: keys }), /unknown skill signing key id/);
  assert.throws(() => verifySignedSkillPackage(signed(current, "review", "skill-current"), {
    publicKeys: [metadata(current, "skill-current", "revoked", { revoked_at: "2026-01-01T00:00:00Z" })],
    now: "2026-01-02T00:00:00Z",
  }), /revoked or expired/);
  assert.throws(() => verifySignedSkillPackage(signed(next, "review", "skill-next"), {
    publicKeys: [metadata(next, "skill-next", "current", { expires_at: "2026-01-01T00:00:00Z" })],
    now: "2026-01-02T00:00:00Z",
  }), /revoked or expired/);
});

test("snapshot signing keys remain authoritative when present, including an explicit empty set", () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const fallback = { publicKey, keyId: "skill-key-1" };
  const empty = skillSigningVerificationForSnapshot({ skill_signing_keys: [] }, fallback);
  assert.deepEqual(empty.publicKeys, []);
  assert.throws(() => verifySignedSkillPackage(signed(key), empty), SkillVerificationError);
  assert.throws(() => skillSigningVerificationForSnapshot({ skill_signing_keys: [{ malformed: true }] }, fallback), SkillVerificationError);
});

test("snapshot skill references accept current skills and legacy skill_refs", () => {
  assert.deepEqual(skillRefsForSnapshot({ skills: ["current"], skill_refs: ["stale"] }), ["current"]);
  assert.deepEqual(skillRefsForSnapshot({ skill_refs: ["legacy"] }), ["legacy"]);
  assert.deepEqual(skillRefsForSnapshot({ skills: [] as string[], skill_refs: ["stale"] }), []);
  assert.throws(() => skillRefsForSnapshot({ skills: { stale: true }, skill_refs: ["legacy"] }), SkillVerificationError);
});

test("cache rejects symlink roots and ancestors before any outside mutation", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-links-"));
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-outside-"));
  const marker = join(outside, "must-survive");
  mkdirSync(marker);
  try {
    const linkedRoot = join(base, "root");
    symlinkSync(outside, linkedRoot);
    assert.throws(() => new SkillCache(linkedRoot), SkillVerificationError);
    assert.equal(existsSync(marker), true);
    const linkedAncestor = join(base, "ancestor");
    symlinkSync(outside, linkedAncestor);
    assert.throws(() => new SkillCache(join(linkedAncestor, "skills")), SkillVerificationError);
    assert.equal(existsSync(marker), true);
    assert.deepEqual(readdirSync(outside), ["must-survive"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("signed skill verifies and cache stays scoped by tenant/member", () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-"));
  try {
    const cache = new SkillCache(root);
    const envelope = signed(key);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [envelope], ["review"], verification(publicKey));
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)).length, 1);
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-b" }, ["review"], verification(publicKey)).length, 0);
    assert.equal(cache.pathsFor({ tenantId: "tenant-b", memberId: "member-a" }, ["review"], verification(publicKey)).length, 0);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [], ["review"], verification(publicKey), { authoritative: false });
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)).length, 1);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [], [], verification(publicKey));
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("authoritative empty Manager sync prunes revoked cached skills", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const cacheRoot = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-authoritative-empty-"));
  const fixture = await createFixture();
  const cache = new SkillCache(cacheRoot);
  cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review"], verification(publicKey));
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    skillCache: cache,
    authenticate: () => ({ callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] }),
    managerClient: {
      pullAuthorizedConfig: async () => ({
        experts: [{ employee_id: "employee-1", tenant_id: "tenant-a", member_id: "member-a", version: "1", skills: ["review"] }],
        solutions: [],
        skill_packages: [],
      }),
    } as any,
  });
  process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
  process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/sync`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-a", member_id: "member-a", known_versions: {} }) });
    assert.equal(response.status, 200);
    assert.deepEqual(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)), []);
  } finally {
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
    await http.close();
    await fixture.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("sync while a run is active keeps cached skill files, and prunes them on a later idle sync", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const cacheRoot = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-active-run-"));
  const fixture = await createFixture();
  const cache = new SkillCache(cacheRoot);
  let running = true;
  (fixture.host as any).hasActiveRunsFor = (tenantId: string, memberId: string) => running && tenantId === "tenant-a" && memberId === "member-a";
  cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review"], verification(publicKey));
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    skillCache: cache,
    authenticate: () => ({ callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] }),
    managerClient: {
      pullAuthorizedConfig: async () => ({
        experts: [{ employee_id: "employee-1", tenant_id: "tenant-a", member_id: "member-a", version: "1", skills: ["review"] }],
        solutions: [],
        skill_packages: [],
      }),
    } as any,
  });
  process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
  process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/sync`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-a", member_id: "member-a", known_versions: {} }) });
    assert.equal(response.status, 200);
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)).length, 1);
    running = false;
    const idle = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/sync`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-a", member_id: "member-a", known_versions: {} }) });
    assert.equal(idle.status, 200);
    assert.deepEqual(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)), []);
  } finally {
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
    await http.close();
    await fixture.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("non-authoritative empty signing keys preserve an existing usable cache", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const cacheRoot = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-non-authoritative-keys-"));
  const fixture = await createFixture();
  const cache = new SkillCache(cacheRoot);
  cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review"], verification(publicKey));
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    skillCache: cache,
    authenticate: () => ({ callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] }),
    managerClient: {
      pullAuthorizedConfig: async () => ({
        experts: [{ employee_id: "employee-1", tenant_id: "tenant-a", member_id: "member-a", version: "1", skills: ["review"] }],
        solutions: [], snapshots: [], revoked_ids: [],
        skill_packages_authoritative: false,
        skill_signing_keys: [],
      }),
    } as any,
  });
  process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
  process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/sync`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-a", member_id: "member-a", known_versions: {} }) });
    assert.equal(response.status, 200);
    assert.equal(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)).length, 1);
  } finally {
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
    await http.close();
    await fixture.close();
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test("resource loader uses only the current snapshot skill allowlist", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-loader-"));
  try {
    const cache = new SkillCache(root);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key, "review"), signed(key, "other")], ["review", "other"], verification(publicKey));
    process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
    process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
    const loader = createControlledResourceLoader("system", cache, { caller: { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: [] }, employeeId: "e1", snapshot: { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "E", skill_refs: ["review"] } });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["review"]);
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resource loader loads canonical skills when legacy skill_refs is absent", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-canonical-loader-"));
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-canonical-workspace-"));
  const agentDir = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-canonical-agent-"));
  try {
    const cache = new SkillCache(root);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review"], verification(publicKey));
    process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
    process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
    const loader = createControlledResourceLoader("system", cache, {
      caller: { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: [] },
      employeeId: "e1",
      snapshot: { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "Review", skills: ["review"] },
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["review"]);
    await loader.shutdown();
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
  } finally {
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("offline key cache revalidates within TTL and rejects revoked or stale keys", () => {
  const key = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-rotation-cache-"));
  const cache = new SkillCache(root, { offlineTtlSeconds: 3600 });
  const current = metadata(key, "skill-current");
  try {
    cache.reconcile(scope, [signed(key, "review", "skill-current")], ["review"], { publicKeys: [current], now: "2026-01-01T00:00:00Z" });
    assert.equal(cache.pathsFor(scope, ["review"], { now: "2026-01-01T00:30:00Z" }).length, 1);
    assert.deepEqual(cache.pathsFor(scope, ["review"], { now: "2026-01-01T02:00:00Z" }), []);

    const revoked = metadata(key, "skill-current", "revoked", { revoked_at: "2026-01-01T00:45:00Z" });
    cache.reconcile(scope, [], ["review"], { publicKeys: [revoked], now: "2026-01-01T01:00:00Z" });
    assert.deepEqual(cache.pathsFor(scope, ["review"], { now: "2026-01-01T01:01:00Z" }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persisted cache rejects tampering, symlinks and non-current pointers", () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-tamper-"));
  try {
    const cache = new SkillCache(root);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review"], verification(publicKey));
    const path = cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey))[0];
    appendFileSync(join(path, "SKILL.md"), "tampered");
    assert.deepEqual(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)), []);
    cache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key)], ["review@2"], verification(publicKey));
    assert.deepEqual(cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review@1"], verification(publicKey)), []);
    assert.throws(() => cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review@../review/1"], verification(publicKey)), SkillVerificationError);
    symlinkSync(join(root, "outside"), join(root, "tenant-a", "member-a", "review-link"));
    assert.throws(() => cache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review"], verification(publicKey)), SkillVerificationError);
    const wrongRoot = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-wrong-dir-"));
    try {
      const wrongCache = new SkillCache(wrongRoot);
      wrongCache.reconcile({ tenantId: "tenant-a", memberId: "member-a" }, [signed(key, "other")], ["other"], verification(publicKey));
      mkdirSync(join(wrongRoot, "tenant-a", "member-a", "review"), { recursive: true });
      renameSync(join(wrongRoot, "tenant-a", "member-a", "other", "1"), join(wrongRoot, "tenant-a", "member-a", "review", "1"));
      assert.deepEqual(wrongCache.pathsFor({ tenantId: "tenant-a", memberId: "member-a" }, ["review@1"], verification(publicKey)), []);
    } finally { rmSync(wrongRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scope-invalid signed package is rejected before projection mutation", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const fixture = await createFixture();
  const envelope = signed(key);
  envelope.tenant_id = "tenant-other";
  let replaced = false;
  const originalReplace = fixture.store.replaceProjections.bind(fixture.store);
  fixture.store.replaceProjections = ((...args: Parameters<typeof fixture.store.replaceProjections>) => {
    replaced = true;
    return originalReplace(...args);
  }) as typeof fixture.store.replaceProjections;
  const http = new AgentHttpServer({
    host: fixture.host,
    store: fixture.store,
    authenticate: () => ({ callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: ["member"] }),
    managerClient: {
      pullAuthorizedConfig: async () => ({
        experts: [{ employee_id: "employee-1", tenant_id: "tenant-a", member_id: "member-a", version: "1", skills: ["review"] }],
        solutions: [], skill_packages: [envelope],
      }),
    } as any,
  });
  process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY = publicKey;
  process.env.AITEAM_SKILL_SIGNING_KEY_ID = "skill-key-1";
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/sync`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-a", member_id: "member-a", known_versions: {} }) });
    assert.equal(response.status, 503);
    assert.equal(replaced, false);
  } finally {
    delete process.env.AITEAM_SKILL_SIGNING_PUBLIC_KEY;
    delete process.env.AITEAM_SKILL_SIGNING_KEY_ID;
    await http.close();
    await fixture.close();
  }
});

// Shared with server/tests/shared/test_skill_package_contract.py: Python signs the widened package, Node verifies it.
const contractFixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "skill_package_contract.json"), "utf8")) as {
  accepted_paths: string[]; rejected_paths: string[]; public_key: string; key_id: string; signed: { package: { files: { path: string; content: string; content_hash: string }[] } & Record<string, unknown> } & Record<string, unknown>;
};
function resignedWithPaths(paths: string[]) {
  const key = generateKeyPairSync("ed25519");
  const files = paths.map((path) => ({ path, content: path === "SKILL.md" ? "# S\n" : "x\n", content_hash: sha16(path === "SKILL.md" ? "# S\n" : "x\n") }));
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const pkg = { skill_id: "s", version: "1", content_hash: sha16(JSON.stringify(sorted.map((file) => [file.path, file.content]))), display_name: "S", description: "", files };
  const envelope = { package: pkg, tenant_id: "tenant-a", member_id: "member-a", key_id: "skill-key-1", algorithm: "Ed25519" as const, signature: sign(null, canonicalSignedSkillPackageBytes(pkg, "tenant-a", "member-a"), key.privateKey).toString("base64") };
  return { envelope, options: { publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"), keyId: "skill-key-1" } };
}

test("Node verifies the Python-signed widened package (scripts, json, nested paths)", () => {
  const verified = verifySignedSkillPackage(contractFixture.signed, { publicKey: contractFixture.public_key, keyId: contractFixture.key_id, tenantId: "tenant-a", memberId: "member-a" });
  const paths = verified.package.files.map((file) => file.path);
  assert.ok(paths.includes("scripts/extract-skill.sh") && paths.includes("assets/schema.json") && paths.includes("csv.md"));
  const tampered = structuredClone(contractFixture.signed);
  tampered.package.files[0]!.content += "!";
  assert.throws(() => verifySignedSkillPackage(tampered, { publicKey: contractFixture.public_key, keyId: contractFixture.key_id }), SkillVerificationError);
});

test("Node applies the same accepted and rejected skill paths as Python", () => {
  for (const path of contractFixture.accepted_paths) {
    const { envelope, options } = resignedWithPaths(path === "SKILL.md" ? ["SKILL.md"] : ["SKILL.md", path]);
    assert.doesNotThrow(() => verifySignedSkillPackage(envelope, options), `accepted: ${path}`);
  }
  for (const path of contractFixture.rejected_paths) {
    const { envelope, options } = resignedWithPaths(["SKILL.md", path]);
    assert.throws(() => verifySignedSkillPackage(envelope, options), SkillVerificationError, `rejected: ${JSON.stringify(path)}`);
  }
});

test("Node enforces the package file-count and size limits", () => {
  const many = resignedWithPaths(["SKILL.md", ...Array.from({ length: 256 }, (_, index) => `f${index}.md`)]);
  assert.throws(() => verifySignedSkillPackage(many.envelope, many.options), /too many files/);
  const ok = resignedWithPaths(["SKILL.md", ...Array.from({ length: 255 }, (_, index) => `f${index}.md`)]);
  assert.doesNotThrow(() => verifySignedSkillPackage(ok.envelope, ok.options));
});

test("widened package materializes with nested folders and no executable bit", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-widened-")));
  try {
    const cache = new SkillCache(root);
    const scope = { tenantId: "tenant-a", memberId: "member-a" };
    const options = { publicKey: contractFixture.public_key, keyId: contractFixture.key_id };
    cache.reconcile(scope, [contractFixture.signed as never], ["self-improving-agent"], options);
    const [dir] = cache.pathsFor(scope, ["self-improving-agent"], options);
    assert.ok(dir);
    const script = join(dir!, "scripts", "extract-skill.sh");
    assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\necho extract \"$1\"\n");
    assert.equal(statSync(script).mode & 0o111, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skill verification fails closed for missing/mismatched key, scope and traversal", () => {
  const key = generateKeyPairSync("ed25519");
  const envelope = signed(key);
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.throws(() => verifySignedSkillPackage(envelope, { keyId: "other", publicKey }), SkillVerificationError);
  assert.throws(() => verifySignedSkillPackage(envelope, { keyId: "skill-key-1" }), SkillVerificationError);
  assert.throws(() => verifySignedSkillPackage(envelope, { keyId: "skill-key-1", publicKey, tenantId: "tenant-b" }), SkillVerificationError);
  const bad = { ...envelope, package: { ...envelope.package, files: [{ ...envelope.package.files[0], path: "../SKILL.md" }] } };
  assert.throws(() => verifySignedSkillPackage(bad, { keyId: "skill-key-1", publicKey }), SkillVerificationError);
});

test("required skill readiness blocks unsynced, missing, tampered or unparseable packages and skips only skills the enterprise stopped delivering", async () => {
  const key = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const keys = [metadata(key, "skill-key-1")];
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-s05-readiness-"));
  const fixture = await createFixture();
  const cache = new SkillCache(root);
  fixture.store.replaceProjections([{ employee_id: "s05", tenant_id: scope.tenantId, member_id: scope.memberId, version: "1", display_name: "Fixture", handle: "fixture", revoked: false, synced_at: new Date().toISOString(), skills: ["review"], status: "active", model_policy: { provider_ref: "p", model: "m" } }], [], [{ employee_id: "s05", tenant_id: scope.tenantId, member_id: scope.memberId, version: "1", snapshot_version: "s1", display_name: "Fixture", skills: ["review@1"], skill_signing_keys: keys }], [], scope);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, skillCache: cache, runtimeReady: async () => true,
    authenticate: () => ({ callerId: scope.memberId, userId: scope.memberId, tenantId: scope.tenantId, roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address(); assert(address && typeof address === "object");
  const get = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/experts/s05/readiness`, { headers: { Authorization: "Bearer fixture" } });
    assert.equal(response.status, 200);
    return (await response.json() as any).data;
  };
  try {
    // 从没同步过（新机器 / 同步失败）：不能当成企业已删除，仍然拦下。
    assert.equal((await get()).available, false);
    assert.equal((await get()).skills[0].reason, "skill_missing");
    cache.reconcile(scope, [signed(key)], ["review@1"], { publicKeys: keys });
    const ready = await get();
    assert.equal(ready.available, true, JSON.stringify(ready));
    assert.deepEqual(new SkillCache(root).readinessFor(scope, ["review@1"]), [{ ref: "review@1", status: "ready", version: "1" }]);
    assert.equal(cache.readinessFor({ ...scope, memberId: "other" }, ["review@1"])[0]?.status, "blocked");
    appendFileSync(join(root, scope.tenantId, scope.memberId, "review", "1", "SKILL.md"), "tampered");
    assert.equal((await get()).skills[0].status, "blocked");
    assert.equal((await get()).available, false);
    assert.equal(new SkillCache(root).readinessFor(scope, ["review@1"])[0]?.status, "blocked");
    rmSync(join(root, scope.tenantId, scope.memberId, "review", "1"), { recursive: true });
    assert.equal(new SkillCache(root).readinessFor(scope, ["review@1"])[0]?.reason, "skill_missing");
    // 上次权威同步还下发了它、但缓存被误删：仍然拦下，提示同步。
    const load = () => createControlledResourceLoader("system", cache, { caller: { callerId: scope.memberId, userId: scope.memberId, tenantId: scope.tenantId, roles: [] }, employeeId: "s05", snapshot: { employee_id: "s05", version: "1", snapshot_version: "s1", display_name: "Fixture", skill_refs: ["review@1"] } });
    assert.throws(load, /Required signed skill/);
    assert.equal((await get()).available, false);
    // 运行中的那次同步（只加不清）也记下清单：企业不再下发它 → 算已删除 / 停用。
    cache.reconcile(scope, [], [], { publicKeys: keys }, { authoritative: false, recordDelivered: true });
    assert.equal(new SkillCache(root).readinessFor(scope, ["review@1"])[0]?.reason, "skill_removed");
    assert.equal((await get()).available, true);
    assert.doesNotThrow(load);
    // 不是权威同步（例如单个安装）不改清单。
    cache.reconcile(scope, [signed(key)], ["review@1"], { publicKeys: keys }, { authoritative: false });
    rmSync(join(root, scope.tenantId, scope.memberId, "review", "1"), { recursive: true });
    assert.equal(new SkillCache(root).readinessFor(scope, ["review@1"])[0]?.reason, "skill_removed");
  } finally { await http.close(); await fixture.close(); rmSync(root, { recursive: true, force: true }); }
});

test("actual pinned Pi loader agrees with bounded custom SKILL.md frontmatter contract", () => {
  const key = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-s05-frontmatter-"));
  const cache = new SkillCache(root);
  const valid = ["description: Useful skill", "description: 'Quoted skill'", 'description: "Quoted skill"', "description: |\n  Multi line\n  description", "description: >\n  Folded\n  description", "description: CRLF\r\nname: fixture"];
  const invalid = ["name: fixture", "description: false", "description: [list]", "description: {nested: x}", "description: [broken", "description: ''"];
  try {
    for (const [header, expected] of [...valid.map((header) => [header, "ready"]), ...invalid.map((header) => [header, "blocked"])] as Array<[string, string]>) {
      const envelope = signed(key);
      const content = `---\n${header}\n---\nFixture instructions.`;
      envelope.package.files = [{ path: "SKILL.md", content, content_hash: sha16(content) }];
      envelope.package.content_hash = sha16(JSON.stringify([["SKILL.md", content]]));
      envelope.signature = sign(null, canonicalSignedSkillPackageBytes(envelope.package, scope.tenantId, scope.memberId), key.privateKey).toString("base64");
      cache.reconcile(scope, [envelope], ["review"], { publicKeys: [metadata(key, "skill-key-1")] });
      assert.equal(cache.readinessFor(scope, ["review"])[0]?.status, expected, header);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("displayNameFor returns signed display_name only for the matching verified scope", () => {
  const key = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-display-"));
  try {
    const cache = new SkillCache(root);
    const scope = { tenantId: "tenant-a", memberId: "member-a" };
    cache.reconcile(scope, [signed(key)], ["review"], verification(publicKey));
    assert.equal(cache.displayNameFor(scope, "review", verification(publicKey)), "Review");
    assert.equal(cache.displayNameFor(scope, "review@1", verification(publicKey)), "Review");
    assert.equal(cache.displayNameFor(scope, "review@2", verification(publicKey)), undefined);
    assert.equal(cache.displayNameFor(scope, "missing", verification(publicKey)), undefined);
    assert.equal(cache.displayNameFor({ tenantId: "tenant-a", memberId: "member-b" }, "review", verification(publicKey)), undefined);
    assert.equal(cache.displayNameFor(scope, "review@1", { publicKeys: [metadata(other, "skill-key-1")] }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("authorized expert list exposes signed skill display names without changing skills", async (t) => {
  const key = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const keys = [metadata(key, "skill-key-1")];
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aiteam-skill-details-"));
  const fixture = await createFixture();
  const cache = new SkillCache(root);
  fixture.store.replaceProjections([
    { employee_id: "e1", tenant_id: scope.tenantId, member_id: scope.memberId, version: "1", display_name: "Fixture", handle: "fixture", revoked: false, synced_at: new Date().toISOString(), skills: ["review@1"], status: "active" },
    ...Array.from({ length: 5 }, (_, index) => ({ employee_id: `plain-${index}`, tenant_id: scope.tenantId, member_id: scope.memberId, version: "1", display_name: `Plain ${index}`, handle: `plain-${index}`, revoked: false, synced_at: new Date().toISOString(), skills: [], status: "active" })),
  ], [], [{ employee_id: "e1", tenant_id: scope.tenantId, member_id: scope.memberId, version: "1", snapshot_version: "s1", display_name: "Fixture", skills: ["review@1"], skill_signing_keys: keys }], [], scope);
  const http = new AgentHttpServer({ host: fixture.host, store: fixture.store, skillCache: cache,
    authenticate: () => ({ callerId: scope.memberId, userId: scope.memberId, tenantId: scope.tenantId, roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address(); assert(address && typeof address === "object");
  const listAll = async () => (await (await fetch(`http://127.0.0.1:${address.port}/api/agent/grants/experts`, { headers: { Authorization: "Bearer fixture" } })).json() as any).data as Array<{ employee_id: string; skills: string[]; skill_details: unknown }>;
  const list = async () => (await listAll()).find((expert) => expert.employee_id === "e1")!;
  try {
    assert.deepEqual((await list()).skill_details, [{ ref: "review@1", display_name: null }]);
    // Experts without skills skip the lookup, and one request reads snapshots at most once.
    const snapshotReads = t.mock.method(fixture.store, "listSnapshots");
    const all = await listAll();
    assert.equal(snapshotReads.mock.callCount(), 1);
    assert.deepEqual(all.filter((expert) => expert.employee_id.startsWith("plain-")).map((expert) => expert.skill_details), [[], [], [], [], []]);
    snapshotReads.mock.restore();
    cache.reconcile(scope, [signed(key)], ["review@1"], { publicKeys: keys });
    const expert = await list();
    assert.deepEqual(expert.skills, ["review@1"]);
    assert.deepEqual(expert.skill_details, [{ ref: "review@1", display_name: "Review" }]);
  } finally {
    await http.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an installed personal skill stays usable after the enterprise rotates or revokes its signing key", async () => {
  const oldKey = generateKeyPairSync("ed25519");
  const newKey = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiteam-personal-pin-")));
  try {
    const cache = new SkillCache(root);
    cache.install(scope, signed(oldKey, "review", "skill-old"), [metadata(oldKey, "skill-old")]);
    // 企业换了密钥并吊销旧钥：当前公钥列表里旧钥已是 revoked。
    const rotated = [metadata(newKey, "skill-new"), metadata(oldKey, "skill-old", "revoked", { revoked_at: new Date().toISOString() })];
    assert.equal(cache.pathsFor(scope, ["review@1"], { publicKeys: rotated }).length, 0);
    assert.equal(cache.pathsFor(scope, ["review@1"], cache.installedVerification(scope, "review@1")).length, 1);

    const loader = createControlledResourceLoader("system", undefined, {
      caller: { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: [] },
      employeeId: "e1",
      snapshot: { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "E", skills: [], skill_signing_keys: rotated },
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { cache, refs: ["review@1"] });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["review"]);

    // 重新安装用旧钥签的包：不可以安装，已装的版本原样保留。
    assert.throws(() => cache.install(scope, signed(oldKey, "review", "skill-old"), rotated), SkillVerificationError);
    assert.equal(cache.pathsFor(scope, ["review@1"], cache.installedVerification(scope, "review@1")).length, 1);
    // 用新钥签的包可以正常重装。
    cache.install(scope, signed(newKey, "review", "skill-new"), rotated);
    assert.equal(cache.pathsFor(scope, ["review@1"], { publicKeys: rotated }).length, 1);

    // 撤销时连同安装记录一起删除。
    cache.remove(scope, "review");
    assert.equal(cache.installedVerification(scope, "review@1"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a personal skill installed before pinning is pinned on first successful load", async () => {
  const oldKey = generateKeyPairSync("ed25519");
  const newKey = generateKeyPairSync("ed25519");
  const scope = { tenantId: "tenant-a", memberId: "member-a" };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiteam-personal-legacy-")));
  try {
    const cache = new SkillCache(root);
    // 旧版本安装：只走 reconcile，没有安装记录。
    cache.reconcile(scope, [signed(oldKey, "review", "skill-old")], ["review"], { publicKeys: [metadata(oldKey, "skill-old")] }, { authoritative: false });
    assert.equal(cache.installedVerification(scope, "review@1"), undefined);
    const caller = { callerId: "member-a", userId: "member-a", tenantId: "tenant-a", roles: [] };
    const load = async (keys: SkillSigningKeyMetadata[]) => {
      const loader = createControlledResourceLoader("system", undefined, { caller, employeeId: "e1", snapshot: { employee_id: "e1", version: "1", snapshot_version: "s1", display_name: "E", skills: [], skill_signing_keys: keys } },
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { cache, refs: ["review@1"] });
      await loader.reload();
      return loader.getSkills().skills.map((skill) => skill.name);
    };
    assert.deepEqual(await load([metadata(oldKey, "skill-old")]), ["review"]);
    assert.ok(cache.installedVerification(scope, "review@1"));
    assert.deepEqual(await load([metadata(newKey, "skill-new")]), ["review"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
