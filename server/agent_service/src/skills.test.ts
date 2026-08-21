import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyPairKeyObjectResult } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalSignedSkillPackageBytes, SkillCache, SkillVerificationError, skillRefsForSnapshot, type SkillSigningKeyMetadata, verifySignedSkillPackage } from "./skills.js";
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

test("snapshot skill references accept both current and legacy field names", () => {
  assert.deepEqual(skillRefsForSnapshot({ skill_refs: ["current"] }), ["current"]);
  assert.deepEqual(skillRefsForSnapshot({ skills: ["legacy"] }), ["legacy"]);
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
