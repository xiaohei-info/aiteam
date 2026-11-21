import { describe, expect, it } from "vitest";
import * as root from "../index.js";
import { editorInput, skillImportBody } from "./import-body.js";

describe("skillImportBody", () => {
  it("粘贴 / 网址 / ClawHub 走 JSON，丢掉 files 并合并端上的附加字段", () => {
    expect(skillImportBody({ source: "url", url: "https://example.com/s.md", files: [] }, { visibility: "tenant" }))
      .toEqual({ source: "url", url: "https://example.com/s.md", visibility: "tenant" });
    expect(skillImportBody({ source: "text", text: "---\nname: a\n---\n" })).toEqual({ source: "text", text: "---\nname: a\n---\n" });
  });

  it("上传来源走 multipart：文件与相对路径一一对应，roots 与附加字段逐项追加", () => {
    const a = new File(["# A"], "SKILL.md");
    const b = new File(["echo"], "run.sh");
    const body = skillImportBody(
      { source: "folder", files: [{ file: a, path: "demo/SKILL.md" }, { file: b, path: "demo/scripts/run.sh" }], roots: ["demo"] },
      { binding_policy: "opt_in" },
    );
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("source")).toBe("folder");
    expect(form.getAll("paths")).toEqual(["demo/SKILL.md", "demo/scripts/run.sh"]);
    expect((form.getAll("files") as File[]).map((file) => file.name)).toEqual(["SKILL.md", "run.sh"]);
    expect(form.getAll("roots")).toEqual(["demo"]);
    expect(form.get("binding_policy")).toBe("opt_in");
  });

  it("没有文件也能组出 multipart（服务端负责报缺 SKILL.md）", () => {
    const form = skillImportBody({ source: "zip" }) as FormData;
    expect(form.get("source")).toBe("zip");
    expect(form.getAll("files")).toEqual([]);
  });
});

describe("editorInput", () => {
  it("在线编辑的文件转成 editor 来源的上传，文件名取路径最后一段", () => {
    const input = editorInput([{ path: "SKILL.md", content: "# S" }, { path: "scripts/fill.sh", content: "echo hi\n" }, { path: "dir/", content: "" }]);
    expect(input.source).toBe("editor");
    expect(input.files!.map((item) => [item.path, item.file.name])).toEqual([["SKILL.md", "SKILL.md"], ["scripts/fill.sh", "fill.sh"], ["dir/", "file"]]);
    expect(input.files![1]!.file.size).toBe(8);
  });
});

describe("包入口", () => {
  it("从 @aiteam/shared 根入口能拿到技能导入 / 编辑组件与工具", () => {
    for (const name of ["SkillImportDialog", "SkillEditorDialog", "scannerBadge", "skillImportBody", "editorInput", "attachmentPath"]) {
      expect(root).toHaveProperty(name);
    }
  });
});
