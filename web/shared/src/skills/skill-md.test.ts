import { describe, expect, it } from "vitest";
import { composeSkillMd, parseSkillMd, skillDescriptionProblem, skillNameProblem, skillSummary } from "./skill-md.js";

const SIMPLE = "---\nname: weekly-report\ndescription: 把一周的工作整理成周报。用户要写周报时使用。\nlicense: MIT\n---\n# 周报\n\n1. 收集\n";

describe("SKILL.md 读写", () => {
  it("拆出名称、说明、正文，其余元数据原样保留；不改动时拼回来一字不差", () => {
    const parts = parseSkillMd(SIMPLE);
    expect(parts).toEqual({ name: "weekly-report", description: "把一周的工作整理成周报。用户要写周报时使用。", body: "# 周报\n\n1. 收集\n", extra: "license: MIT" });
    expect(composeSkillMd(parts)).toBe(SIMPLE);
  });

  it("读得懂引号、折叠块与多行嵌套元数据", () => {
    const text = [
      "---",
      'name: "pdf-tools"',
      "description: >",
      "  Extract text from PDFs.",
      "  Use when reading PDFs.",
      "metadata:",
      "  author: me",
      "  tags: [a, b]",
      "allowed-tools: Bash(git:*)",
      "---",
      "body",
    ].join("\n");
    const parts = parseSkillMd(text);
    expect(parts.name).toBe("pdf-tools");
    expect(parts.description).toBe("Extract text from PDFs. Use when reading PDFs.");
    expect(parts.extra).toBe("metadata:\n  author: me\n  tags: [a, b]\nallowed-tools: Bash(git:*)");
    expect(parseSkillMd("---\nname: x\ndescription: |\n  line 1\n  line 2\n---\n").description).toBe("line 1\nline 2");
    expect(parseSkillMd("---\nname: x\ndescription: 'it''s ok'\n---\n").description).toBe("it's ok");
  });

  it("说明里有冒号、井号或像数字时加引号，重新读出来不变", () => {
    for (const description of ["用法: 先读 references/a.md", "数字 #1 的方案", "123", "true", "- 列表开头", "前后 "]) {
      const text = composeSkillMd({ name: "x", description, body: "", extra: "" });
      expect(parseSkillMd(text).description).toBe(description.trim());
    }
  });

  it("没有元数据时整个文件都是正文", () => {
    expect(parseSkillMd("# 只有正文\n")).toEqual({ name: "", description: "", body: "# 只有正文\n", extra: "" });
  });

  it("名称与说明的规则同 Agent Skills 规范", () => {
    expect(skillNameProblem("weekly-report")).toBeNull();
    expect(skillNameProblem("")).toBe("请填写名称");
    expect(skillNameProblem("Weekly_Report")).toMatch(/小写字母/);
    expect(skillNameProblem("a--b")).toMatch(/小写字母/);
    expect(skillNameProblem("a".repeat(65))).toMatch(/64/);
    expect(skillDescriptionProblem(" ")).toMatch(/做什么/);
    expect(skillDescriptionProblem("x".repeat(1025))).toMatch(/1024/);
  });

  it("从文件列表读出名称与说明", () => {
    expect(skillSummary([{ path: "scripts/a.sh", content: "" }, { path: "SKILL.md", content: SIMPLE }]).description).toMatch(/周报/);
    expect(skillSummary([])).toEqual({ name: "", description: "" });
  });
});
