import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "./test-fixture.js";
import { AgentHttpServer } from "./http/server.js";
import { CustomSkillStore } from "./custom-skills.js";

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
