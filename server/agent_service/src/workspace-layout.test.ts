import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { conversationFolder, conversationFolderBase, employeeFolder, folderSegment, WORKSPACE_KEY_PATTERN, workspaceFolderHint } from "./workspace-layout.js";

const short = (id: string, length: number) => createHash("sha256").update(id).digest("hex").slice(0, length);

test("folder names keep the title readable but never hold separators or hidden-file prefixes", () => {
  assert.equal(folderSegment("周报/月报: 汇总*?", "x"), "周报_月报_ 汇总_");
  assert.equal(folderSegment("...隐藏", "x"), "隐藏");
  assert.equal(folderSegment("名".repeat(60), "x"), "名".repeat(40));
  assert.equal(folderSegment("末尾。 . ", "x"), "末尾。");
  assert.equal(folderSegment("///", "employee-1"), "_");
  assert.equal(folderSegment("", "employee-1"), "employee-1");
  for (const name of ["周报_月报_ 汇总_", "名".repeat(40)]) assert.ok(WORKSPACE_KEY_PATTERN.test(name));
});

test("an untitled conversation is named after its employee and creation day", () => {
  assert.equal(conversationFolderBase({ title: "  热门AI项目总结 ", employeeName: "产品经理" }), "热门AI项目总结");
  const created = new Date(2026, 10, 5, 9, 30).toISOString();
  assert.equal(conversationFolderBase({ title: "", employeeName: "产品经理", createdAt: created }), "产品经理-20261105");
  assert.equal(conversationFolderBase({ title: null, employeeName: null, createdAt: created }), "会话-20261105");
});

test("the short ID grows when the folder name is already taken", () => {
  const root = mkdtempSync(join(tmpdir(), "aiteam-workspace-layout-test-"));
  try {
    assert.equal(conversationFolder(root, "总结", "conv-1", () => false), join(root, `总结-${short("conv-1", 6)}`));
    mkdirSync(join(root, `总结-${short("conv-1", 6)}`));
    assert.equal(conversationFolder(root, "总结", "conv-1", () => false), join(root, `总结-${short("conv-1", 12)}`));
    const takenLonger = (path: string) => path.endsWith(short("conv-1", 12));
    assert.equal(conversationFolder(root, "总结", "conv-1", takenLonger), join(root, `总结-${short("conv-1", 24)}`));

    const group = join(root, "组");
    assert.equal(employeeFolder(group, "工程师", "dev-a", () => false), join(group, "工程师"));
    assert.equal(employeeFolder(group, "工程师", "dev-b", (path) => path === join(group, "工程师")), join(group, `工程师-${short("dev-b", 6)}`));
    assert.equal(employeeFolder(group, undefined, "dev-c", () => false), join(group, "dev-c"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("employees that can write files are told how to organize their folder", () => {
  const hint = workspaceFolderHint("workspace-write", ["read", "write"]);
  for (const folder of ["output/", "scripts/", "data/", "top-level folder"]) assert.ok(hint.includes(folder), folder);
  assert.equal(workspaceFolderHint("read-only", ["write"]), "");
  assert.equal(workspaceFolderHint("full-access", ["read", "knowledge_search"]), "");
  assert.notEqual(workspaceFolderHint("full-access", ["bash"]), "");
});
