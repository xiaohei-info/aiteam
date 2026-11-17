import { describe, expect, it } from "vitest";
import { capabilityLabel, renderRules, solutionModeLabel } from "./solutionInfo";

describe("solutionInfo", () => {
  it("旧方案没有 mode 时按组群显示", () => {
    expect(solutionModeLabel(undefined)).toBe("组群");
    expect(solutionModeLabel("solo")).toBe("单人");
  });

  it("规则里的成员引用换成名字，未知引用明确标出", () => {
    const names = new Map([["a", "协调员"]]);
    expect(renderRules("@{a} 先拆解，@{x} 执行", names)).toBe("@协调员 先拆解，@x（未知成员） 执行");
    expect(renderRules(undefined, names)).toBe("");
  });

  it("推荐能力标签带类型与用途", () => {
    expect(capabilityLabel({ kind: "mcp", ref: "mes", display_name: "MES", purpose: "读工单" })).toBe("MCP · MES（mes）：读工单");
    // skill 的 ref 是平台 skill_id（UUID），只展示名称
    expect(capabilityLabel({ kind: "skill", ref: "3f9c9e2a-7b1d", display_name: "抽样检验", purpose: "" })).toBe("skill · 抽样检验");
    expect(capabilityLabel({ kind: "skill", ref: "sk-1" })).toBe("skill · sk-1");
  });
});
