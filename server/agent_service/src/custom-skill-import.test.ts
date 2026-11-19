import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "./test-fixture.js";
import { AgentHttpServer } from "./http/server.js";
import { CustomSkillStore } from "./custom-skills.js";
import { AgentSqliteStore } from "./storage/sqlite.js";

/**
 * 自定义技能导入的三种多技能 / 单文件场景，走完整 HTTP 入口：
 *  1. 一个文件夹下多个技能 → preview 出清单，勾选批量安装；
 *  2. 一个 zip 下多个技能 → 同上；
 *  3. 单个 .md 文件 → 直接装成一个技能，名字取自 frontmatter。
 * 这些是本机能力，只对本成员生效。
 */

const SKILL_A = `---\nname: weekly-report\ndescription: 把一周的工作记录整理成固定格式的周报\n---\n\n按模板输出周报。\n`;
const SKILL_B = `---\nname: ppt-outline\ndescription: 按主题产出 PPT 大纲\n---\n\n按页型产出大纲。\n`;

function makeZip(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aiteam-import-zip-"));
  const target = join(root, "bundle.zip");
  writeFileSync(target, zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content)]))));
  return target;
}

function writeFolder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aiteam-import-http-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/**
 * 本地假 ClawHub：只实现接入用到的三个端点，避免测试依赖外网。
 * `/download` 返回一个含 SKILL.md 与 OpenClaw 钩子的 zip。
 */
async function fakeClawHub(handle: string, opts?: { ambiguous?: boolean }): Promise<{ url: string; close: () => Promise<void> }> {
  const zip = zipSync({
    "SKILL.md": Buffer.from(SKILL_A),
    "assets/LEARNINGS.md": Buffer.from("记录"),
    "hooks/openclaw/handler.js": Buffer.from("openclaw hook"),
    "scripts/extract-skill.sh": Buffer.from("技能自带脚本"),
  });
  let base = "http://127.0.0.1";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/v1/skills/self-improving-agent") {
      if (opts?.ambiguous) return json(409, { code: "AMBIGUOUS_SKILL_SLUG", slug: "self-improving-agent", matches: [
        { ownerHandle: "alice", slug: "self-improving-agent", url: `${base}/alice/skills/self-improving-agent` },
        { ownerHandle: "bob", slug: "self-improving-agent", url: "http://x/bob/skills/self-improving-agent" },
      ] });
      return json(200, { skill: { slug: "self-improving-agent" }, latestVersion: { version: "1.0.0" } });
    }
    if (url.pathname === "/api/v1/search") return json(200, { results: [{ install: { reference: "alice/self-improving-agent" }, downloads: 1200 }] });
    if (url.pathname === "/api/v1/skills/self-improving-agent/scan") return json(200, { security: { status: "clean", hasWarnings: true, scanners: { skillspector: { status: "suspicious", recommendation: "DO_NOT_INSTALL", severity: "CRITICAL", issueCount: 3 }, llm: { status: "clean", verdict: "benign", confidence: "high" } } } });
    if (url.pathname === "/api/v1/download") {
      if (url.searchParams.get("ownerHandle") !== handle) { res.writeHead(404); return res.end("wrong owner"); }
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from(zip));
    }
    res.writeHead(404); res.end("Not found");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  base = `http://127.0.0.1:${address.port}`;
  return { url: base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function post(base: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`${base}/api/agent/capabilities/skills/custom`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any };
}

test("文件夹里多个技能：preview 出清单，批量安装所选", async () => {
  const fixture = await createFixture();
  const root = writeFolder({
    "01-weekly-report/SKILL.md": SKILL_A,
    "02-ppt-outline/SKILL.md": SKILL_B,
    "02-ppt-outline/templates/page-types.md": "页型说明",
  });
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // 文件夹要经 host 的 customSkillStore 读取：把它挂到 fixture 上。
    const first = await post(base, { source: "folder", path: root, preview: true });
    assert.equal(first.status, 200);
    const scan = first.data.data.scan as Array<{ root: string; name: string; ok: boolean }>;
    assert.equal(scan.length, 2, "一个文件夹下有两个技能，应扫出两条");
    assert.deepEqual(scan.map((item) => item.name).sort(), ["ppt-outline", "weekly-report"]);
    assert.ok(scan.every((item) => item.ok));

    // 先只装扫描到的第一个（不指定 roots 时装第一个）。
    const one = await post(base, { source: "folder", path: root, roots: ["02-ppt-outline"] });
    assert.equal(one.status, 200);
    assert.equal(one.data.data.capability.ref, "ppt-outline");
    assert.deepEqual(store.list(scope).map((item) => item.record.name), ["ppt-outline"]);

    // 批量：一次装扫描到的全部（此时 ppt-outline 已存在，须 replace）。
    const both = await post(base, { source: "folder", path: root, replace: true });
    assert.equal(both.status, 200);
    const results = both.data.data.results as Array<{ root: string; name: string; ok: boolean }>;
    assert.equal(results.length, 2, "不指定 roots 时装扫描到的全部");
    assert.ok(results.every((item) => item.ok));
    assert.deepEqual(store.list(scope).map((item) => item.record.name).sort(), ["ppt-outline", "weekly-report"]);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("单个 .md 文件：装成一个技能，名字取自 frontmatter 而非文件名", async () => {
  const fixture = await createFixture();
  const root = writeFolder({ "我的周报说明.md": SKILL_A });
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const preview = await post(base, { source: "file", path: join(root, "我的周报说明.md"), preview: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.data.preview.name, "weekly-report");

    const installed = await post(base, { source: "file", path: join(root, "我的周报说明.md") });
    assert.equal(installed.status, 200);
    assert.equal(installed.data.data.capability.ref, "weekly-report");
    assert.equal(installed.data.data.capability.kind, "skill");
    assert.equal(store.list(scope)[0]?.record.origin.kind, "file");
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("ClawHub：带作者直接下载，跳过 OpenClaw 钩子，来源记 ClawHub", async () => {
  const mock = await fakeClawHub("alice");
  const fixture = await createFixture();
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // 把 ClawHub 主机指向本地 mock（测试注入）
    process.env.AITEAM_CLAWHUB_BASE_URL = mock.url;
    const preview = await post(base, { source: "clawhub", url: `${mock.url}/alice/skills/self-improving-agent`, preview: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.data.preview.name, "weekly-report");
    assert.equal(preview.data.data.clawhub.skipped.length, 1, "只跳过 hooks/openclaw/handler.js");
    assert.deepEqual(preview.data.data.clawhub.skipped, ["hooks/openclaw/handler.js"]);
    assert.equal(preview.data.data.clawhub.security.scanners.length, 2, "两个扫描器并列");
    assert.equal(preview.data.data.clawhub.candidates, null, "带作者时不用选");

    const installed = await post(base, { source: "clawhub", url: `${mock.url}/alice/skills/self-improving-agent` });
    assert.equal(installed.status, 200);
    const capability = installed.data.data.capability;
    assert.equal(capability.source, "clawhub_catalog");
    assert.equal(capability.url, `${mock.url}/alice/skills/self-improving-agent`);
    // 技能自带脚本保留
    assert.ok(store.list(scope)[0]!.record.origin.kind === "clawhub");
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
  } finally {
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
    await http.close();
    await mock.close();
    await fixture.close();
  }
});

test("ClawHub 技能也带文件完整性标签，改了文件会标 modified", async () => {
  const mock = await fakeClawHub("alice");
  const fixture = await createFixture();
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: "Bearer test" };
  try {
    process.env.AITEAM_CLAWHUB_BASE_URL = mock.url;
    const installed = await post(base, { source: "clawhub", url: `${mock.url}/alice/skills/self-improving-agent` });
    assert.equal(installed.data.data.capability.integrity, "ok", "刚装好应为未改动");
    assert.equal(installed.data.data.capability.origin_label, "ClawHub");
    // 模拟「用户手动改了本机文件」：完整性应变成 modified 并停用。
    const dir = store.pathFor({ tenantId: "tenant-1", memberId: "member-1" }, "weekly-report");
    assert.ok(dir, "应能拿到本机目录");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: tampered\ndescription: 被改过\n---\n");
    const listed = await (await fetch(`${base}/api/agent/capabilities`, { headers })).json() as { data: Array<{ ref: string; integrity?: string; source?: string }> };
    const row = listed.data.find((item) => item.ref === "weekly-report");
    assert.equal(row?.integrity, "modified", "文件被改后应标 modified");
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
  } finally {
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
    await http.close();
    await mock.close();
    await fixture.close();
  }
});

test("旧库（CHECK 里没有 clawhub_catalog）也能装 ClawHub 技能", async () => {
  // 模拟早期迁移后的表：source CHECK 只到 user_import。SQLite 不能扩宽 CHECK，必须靠重建迁移。
  const fixture = await createFixture();
  const raw = (fixture.store as unknown as { db: { exec: (sql: string) => void } }).db;
  raw.exec(`ALTER TABLE local_capability RENAME TO local_capability_old;
    CREATE TABLE local_capability (
      tenant_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('mcp','skill')),
      ref TEXT NOT NULL, display_name TEXT NOT NULL, url TEXT NOT NULL, tools_json TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user_url','enterprise_catalog','platform_catalog','user_import')),
      version TEXT NOT NULL DEFAULT '', source_ref TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      approved_by TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, member_id, kind, ref));
    INSERT INTO local_capability (tenant_id, member_id, kind, ref, display_name, url, tools_json, source, version, source_ref, reason, approved_by, created_at) SELECT tenant_id, member_id, kind, ref, display_name, url, tools_json, source, version, source_ref, reason, approved_by, created_at FROM local_capability_old; DROP TABLE local_capability_old;`);
  // 重新打开存储触发迁移
  const reopened = new (fixture.store.constructor as new (path: string) => AgentSqliteStore)(join(fixture.dataRoot, "agent.sqlite"));
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  reopened.putLocalCapability(scope.tenantId, scope.memberId, {
    kind: "skill", ref: "self-improving-agent", display_name: "self-improving agent",
    url: "https://clawhub.ai/pskoett/skills/self-improving-agent", tools: [],
    source: "clawhub_catalog", version: "4.0.5", source_ref: "", reason: "", approved_by: "member-1",
  });
  assert.equal(reopened.listLocalCapabilities(scope.tenantId, scope.memberId)[0]?.source, "clawhub_catalog");
  reopened.close();
  await fixture.close();
});

test("ClawHub：不带作者且同名多个时返回候选，不猜", async () => {
  const mock = await fakeClawHub("alice", { ambiguous: true });
  const fixture = await createFixture();
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    process.env.AITEAM_CLAWHUB_BASE_URL = mock.url;
    const preview = await post(base, { source: "clawhub", url: `${mock.url}/skills/self-improving-agent`, preview: true });
    assert.equal(preview.status, 200);
    const candidates = preview.data.data.clawhub.candidates;
    assert.equal(candidates.length, 2, "多个同名技能交给界面选");
    assert.equal(candidates[0].owner, "alice", "按下载量排序");
    assert.equal(candidates[0].downloads, 1200);
    assert.ok(candidates[0].url.startsWith("http"), "候选带可点开的链接");
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
  } finally {
    delete process.env.AITEAM_CLAWHUB_BASE_URL;
    await http.close();
    await mock.close();
    await fixture.close();
  }
});

test("批量安装默认只装校验通过的，坏条目不进安装清单", async () => {
  const fixture = await createFixture();
  const root = writeFolder({
    "01-good/SKILL.md": SKILL_A,
    // Pi 对 name 不规范只给 warning，但仍会加载；这里用 frontmatter 里写死的非法 name 触发拒绝。
    "02-bad/SKILL.md": "---\nname: Bad_Name\ndescription: 名字不合规\n---\n",
  });
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const scanned = await post(base, { source: "folder", path: root, preview: true });
    assert.equal((scanned.data.data.scan as unknown[]).length, 2);
    const installed = await post(base, { source: "folder", path: root });
    assert.equal(installed.status, 200);
    // 坏条目不进安装清单：只剩一个可装，于是走单技能路径。
    assert.equal(installed.data.data.capability.ref, "weekly-report");
    assert.deepEqual(store.list(scope).map((item) => item.record.name), ["weekly-report"]);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});

test("zip 里多个技能：preview 出清单，批量安装所选", async () => {
  const fixture = await createFixture();
  const zip = makeZip({
    "01-weekly-report/SKILL.md": SKILL_A,
    "02-ppt-outline/SKILL.md": SKILL_B,
    "__MACOSX/02-ppt-outline/._SKILL.md": "垃圾条目",
  });
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const first = await post(base, { source: "zip", path: zip, preview: true });
    assert.equal(first.status, 200);
    const scan = first.data.data.scan as Array<{ root: string; name: string; ok: boolean }>;
    assert.equal(scan.length, 2, "zip 里有两个技能，应扫出两条（__MACOSX 被忽略）");
    assert.deepEqual(scan.map((item) => item.name).sort(), ["ppt-outline", "weekly-report"]);

    const both = await post(base, { source: "zip", path: zip });
    assert.equal(both.status, 200);
    assert.deepEqual(store.list(scope).map((item) => item.record.name).sort(), ["ppt-outline", "weekly-report"]);
  } finally {
    await http.close();
    rmSync(join(zip, ".."), { recursive: true, force: true });
    await fixture.close();
  }
});

test("单个 .md 只接受 .md；文件夹/zip 里没有 SKILL.md 时报错", async () => {
  const fixture = await createFixture();
  const root = writeFolder({ "notes.txt": "不是技能" });
  const store = new CustomSkillStore(mkdtempSync(join(tmpdir(), "aiteam-custom-store-")));
  const scope = { tenantId: "tenant-1", memberId: "member-1" };
  const host = fixture.createHost(undefined, undefined, undefined, undefined, { customSkillStore: store });
  const http = new AgentHttpServer({ host, store: fixture.store, authenticate: () => ({ callerId: "member-1", userId: "member-1", tenantId: "tenant-1", roles: ["member"] }) });
  await http.listen(0);
  const address = http.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const wrong = await post(base, { source: "file", path: join(root, "notes.txt") });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.data.code, "invalid_skill_package");
    const empty = await post(base, { source: "folder", path: root });
    assert.equal(empty.status, 422);
    assert.equal(empty.data.code, "invalid_skill_package");
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
    await fixture.close();
  }
});
