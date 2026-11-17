import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TeamSection } from "./TeamSection";
import { orchestrationState, checklist } from "./workflow";
import type { Gate, GeneratedSolution } from "./types";

const expert = (key: string, name: string) => ({
  key, display_name: name, category: "质检", description: "d", system_prompt: "p", evidence: [],
});
const solution = {
  display_name: "方案", description: "d", tags: [], coordinator_key: "lead", coordinator_instructions: "",
  output_requirements: "", evidence: [], mode: "group", orchestration_rules: "1. @{lead} 拆解\n2. @{qc} 检验",
  experts: [expert("lead", "协调员"), expert("qc", "质检员")],
} as unknown as GeneratedSolution;
const gate = (key: Gate["key"], ok: boolean, message = ""): Gate => ({ key, ok, message });

function renderTeam(gates: Gate[], props: Partial<{ canEdit: boolean; isLocked: boolean }> = {}) {
  const onConfirm = vi.fn();
  const onChangeCoordinator = vi.fn();
  render(
    <TeamSection
      solution={solution} state={orchestrationState(gates)} canEdit={props.canEdit ?? true}
      isLocked={props.isLocked ?? false} busy={false} onChangeCoordinator={onChangeCoordinator} onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onChangeCoordinator };
}

describe("TeamSection", () => {
  it("群主、成员、规则在同一块里，规则里的引用显示成名字", () => {
    renderTeam([gate("coordinator", false), gate("rules", false)]);
    expect(screen.getByText("成员（2）")).toBeInTheDocument();
    expect(screen.getByText("群主")).toBeInTheDocument();
    expect(screen.getByText("@协调员")).toBeInTheDocument();
    expect(screen.getByText("@质检员")).toBeInTheDocument();
  });

  it("一个按钮确认群主与规则，依次提交两个未生效项", () => {
    const { onConfirm } = renderTeam([gate("coordinator", false), gate("rules", false)]);
    expect(screen.getByText("「协调员」", { selector: "strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认群主与编排规则" }));
    expect(onConfirm).toHaveBeenCalledWith(["coordinator", "rules"]);
  });

  it("设为群主走更换回调；已是群主的成员没有该按钮", () => {
    const { onChangeCoordinator } = renderTeam([gate("coordinator", true), gate("rules", true)]);
    expect(screen.queryByRole("button", { name: "设「协调员」为群主" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设「质检员」为群主" }));
    expect(onChangeCoordinator).toHaveBeenCalledWith("qc");
  });

  it("没有规则时不能确认，并写明原因", () => {
    renderTeam([gate("coordinator", false), gate("rules", false, "orchestration rules are required for a group solution")]);
    expect((screen.getByRole("button", { name: "确认群主与编排规则" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/还没有编排规则，请先/)).toBeInTheDocument();
  });

  it("正文编辑中锁住确认与更换", () => {
    renderTeam([gate("coordinator", false), gate("rules", false)], { isLocked: true });
    expect((screen.getByRole("button", { name: "确认群主与编排规则" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "设「质检员」为群主" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("checklist", () => {
  it("群主与规则合成一行；单人方案没有这一行", () => {
    const rows = checklist({ open_finding_count: 2, gates: [gate("coordinator", false), gate("rules", true)] });
    expect(rows.map((row) => [row.key, row.ok])).toEqual([["findings", false], ["orchestration", false]]);
    expect(checklist({ open_finding_count: 0, gates: [gate("findings", true)] }).map((row) => row.key)).toEqual(["findings"]);
  });
  it("确认后内容被改动时标记为需要重新确认", () => {
    const state = orchestrationState([gate("coordinator", false, "coordinator changed after it was confirmed"), gate("rules", true)]);
    expect(state).toMatchObject({ stale: true, pending: ["coordinator"], blocked: false });
  });
});
