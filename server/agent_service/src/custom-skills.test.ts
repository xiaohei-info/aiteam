import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CustomSkillError, CustomSkillStore, normalizeSkillAtRoot, normalizeSkillPackage, readSkillFolder, scanSkillRoots, toLocalPath, unzipEntries } from "./custom-skills.js";

const SKILL_MD = "---\nname: excel-report\ndescription: 按模板生成周报\n---\n\n# 周报\n";

function folderWith(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "aiteam-custom-skill-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

test("normalizeSkillPackage 认可根目录与单层包装的 SKILL.md", () => {
  const root = normalizeSkillPackage([{ path: "SKILL.md", content: Buffer.from(SKILL_MD) }], { kind: "text", label: "粘贴 SKILL.md" });
  assert.equal(root.name, "excel-report");
  assert.equal(root.origin.label, "粘贴 SKILL.md");

  const wrapped = normalizeSkillPackage([
    { path: "excel-report/SKILL.md", content: Buffer.from(SKILL_MD) },
    { path: "excel-report/template.xlsx", content: Buffer.from("binary") },
  ], { kind: "url", label: "https://github.com/x/y", url: "https://github.com/x/y" });
  assert.equal(wrapped.files.length, 2);
  assert.deepEqual(wrapped.files.map((file) => file.path).sort(), ["SKILL.md", "template.xlsx"]);
});

test("没有 SKILL.md、多个顶层目录或非法 name 都会被拒绝并给出中文原因", () => {
  assert.throws(() => normalizeSkillPackage([{ path: "README.md", content: Buffer.from("x") }], { kind: "folder", label: "本机文件夹" }), /找不到 SKILL.md/);
  assert.throws(() => normalizeSkillPackage([
    { path: "a/SKILL.md", content: Buffer.from(SKILL_MD) },
    { path: "b/SKILL.md", content: Buffer.from(SKILL_MD) },
  ], { kind: "folder", label: "本机文件夹" }), /找不到 SKILL.md/);
  assert.throws(() => normalizeSkillPackage([{ path: "SKILL.md", content: Buffer.from("---\nname: Bad_Name\ndescription: x\n---\n") }], { kind: "text", label: "粘贴" }), /name/);
  assert.throws(() => normalizeSkillPackage([{ path: "../escape/SKILL.md", content: Buffer.from(SKILL_MD) }], { kind: "folder", label: "本机文件夹" }), /上级目录/);
  assert.throws(() => normalizeSkillPackage([{ path: "/etc/SKILL.md", content: Buffer.from(SKILL_MD) }], { kind: "folder", label: "本机文件夹" }), /路径无效/);
});

test("readSkillFolder 跳过 .git / .DS_Store 与软链接", async () => {
  const root = folderWith({ "SKILL.md": SKILL_MD, ".git/config": "git", ".DS_Store": "junk" });
  symlinkSync(join(root, "SKILL.md"), join(root, "link.md"));
  try {
    const files = await readSkillFolder(root);
    assert.deepEqual(files.map((file) => file.path).sort(), ["SKILL.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unzipEntries 拒绝 zip 炸弹式的解压上限", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const big = Buffer.alloc(12 * 1024 * 1024, 1);
  const zip = zipSync({ "big/SKILL.md": strToU8(SKILL_MD), "big/blob.bin": new Uint8Array(big) });
  assert.throws(() => unzipEntries(Buffer.from(zip)), /超过上限/);
});

test("CustomSkillStore 安装后可列出、路径可加载，文件被改动后停用", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-custom-store-"));
  try {
    const store = new CustomSkillStore(root);
    const scope = { tenantId: "tenant-1", memberId: "member-1" };
    const pkg = normalizeSkillPackage([{ path: "SKILL.md", content: Buffer.from(SKILL_MD) }], { kind: "text", label: "粘贴 SKILL.md" });
    const record = store.install(scope, pkg);
    assert.equal(record.name, "excel-report");
    assert.match(record.version, /^[0-9a-f]{16}$/);
    const listed = store.list(scope);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.modified, false);
    const dir = store.pathFor(scope, "excel-report");
    assert.ok(dir && dir.endsWith("files"));

    const filesDir = join(root, "tenant-1", "member-1", "excel-report", "files");
    writeFileSync(join(filesDir, "SKILL.md"), `${SKILL_MD}\n改过了\n`);
    const after = store.list(scope);
    assert.equal(after[0]!.modified, true);
    assert.equal(store.pathFor(scope, "excel-report"), undefined);

    assert.equal(store.remove(scope, "excel-report"), true);
    assert.equal(store.remove(scope, "excel-report"), false);
    assert.deepEqual(store.list(scope), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CustomSkillError 带可判定的错误码", () => {
  const error = new CustomSkillError("skill_too_large", "太大");
  assert.equal(error.code, "skill_too_large");
  assert.equal(error.message, "太大");
});

test("file:// 地址还原成绝对路径（Tauri 文件选择会返回 URL）", () => {
  assert.equal(toLocalPath("file:///Users/edy/Downloads/skill"), "/Users/edy/Downloads/skill");
  assert.equal(toLocalPath("file://localhost/Users/edy/skill"), "/Users/edy/skill");
  assert.equal(toLocalPath("/Users/edy/skill"), "/Users/edy/skill");
  assert.equal(toLocalPath("file:///C:/Users/edy/skill"), "C:/Users/edy/skill");
  assert.equal(toLocalPath("file:///Users/edy/%E6%96%87%E6%A1%A3"), "/Users/edy/文档");
});

test("readSkillFolder 接受 file:// 文件夹地址", async () => {
  const root = folderWith({ "SKILL.md": SKILL_MD });
  try {
    const files = await readSkillFolder(`file://${root}`);
    assert.deepEqual(files.map((file) => file.path), ["SKILL.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSkillRoots 找出包内所有技能根（含包根本身就是技能）", () => {
  const files = [
    { path: "01-weekly-report/SKILL.md", content: Buffer.from(SKILL_MD) },
    { path: "02-ppt-outline/SKILL.md", content: Buffer.from(SKILL_MD) },
    { path: "02-ppt-outline/templates/page-types.md", content: Buffer.from("x") },
  ];
  assert.deepEqual(scanSkillRoots(files), ["01-weekly-report", "02-ppt-outline"]);

  const single = [{ path: "SKILL.md", content: Buffer.from(SKILL_MD) }];
  assert.deepEqual(scanSkillRoots(single), [""]);

  const none = [{ path: "README.md", content: Buffer.from("x") }];
  assert.deepEqual(scanSkillRoots(none), []);
});

test("多个技能根时逐个规范化，互不影响", () => {
  const files = [
    { path: "01-weekly-report/SKILL.md", content: Buffer.from("---\nname: weekly-report\ndescription: 周报\n---\n") },
    { path: "02-ppt-outline/SKILL.md", content: Buffer.from("---\nname: ppt-outline\ndescription: PPT\n---\n") },
    { path: "02-ppt-outline/templates/page-types.md", content: Buffer.from("页型") },
  ];
  const roots = scanSkillRoots(files);
  const a = normalizeSkillAtRoot(files, roots[0]!, { kind: "zip", label: "本机 zip" });
  const b = normalizeSkillAtRoot(files, roots[1]!, { kind: "zip", label: "本机 zip" });
  assert.equal(a.name, "weekly-report");
  assert.deepEqual(a.files.map((file) => file.path), ["SKILL.md"]);
  assert.equal(b.name, "ppt-outline");
  assert.deepEqual(b.files.map((file) => file.path), ["SKILL.md", "templates/page-types.md"]);
});
