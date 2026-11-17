import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RulesSection } from "./RulesSection";
import type { GeneratedSolution } from "./types";

function solution(rules: string): GeneratedSolution {
  const expert = (key: string, name: string) => ({
    key, display_name: name, category: "质检", description: "d", system_prompt: "p", evidence: [],
  });
  return {
    display_name: "方案", description: "d", tags: [], coordinator_key: "lead", coordinator_instructions: "",
    output_requirements: "", evidence: [], mode: "group", orchestration_rules: rules,
    experts: [expert("lead", "协调员"), expert("qc", "质检员")],
  } as unknown as GeneratedSolution;
}

describe("RulesSection", () => {
  it("编辑时「插入成员」把引用追加到规则末尾", () => {
    const onChange = vi.fn();
    render(<RulesSection solution={solution("1. 先拆解")} busy={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "插入成员 质检员" }));
    expect(onChange).toHaveBeenCalledWith("1. 先拆解 @{qc}");
  });

  it("编辑时即时校验引用：非法引用显示原因，合法显示通过", () => {
    const { rerender } = render(<RulesSection solution={solution("@{ghost} 做事")} busy={false} onChange={() => {}} />);
    expect(screen.getByText(/引用了方案外的成员/)).toBeInTheDocument();
    expect(screen.queryByText("成员引用都有效")).not.toBeInTheDocument();
    rerender(<RulesSection solution={solution("@{lead} 先做")} busy={false} onChange={() => {}} />);
    expect(screen.getByText("成员引用都有效")).toBeInTheDocument();
  });
});
