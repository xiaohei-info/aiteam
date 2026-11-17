import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderTeam(gates: Gate[], props: Partial<{ canEdit: boolean; active: string | null }> = {}) {
  const onConfirm = vi.fn();
  const onChangeCoordinator = vi.fn();
  const onSave = vi.fn().mockResolvedValue(null);
  render(
    <TeamSection
      solution={solution} version={1} state={orchestrationState(gates)} canEdit={props.canEdit ?? true}
      active={props.active ?? null} onActiveChange={() => {}} onSave={onSave}
      busy={false} onChangeCoordinator={onChangeCoordinator} onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onChangeCoordinator, onSave };
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

  it("其它分区编辑中锁住确认、更换群主与本节编辑", () => {
    renderTeam([gate("coordinator", false), gate("rules", false)], { active: "overview" });
    expect((screen.getByRole("button", { name: "编辑规则" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "确认群主与编排规则" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "设「质检员」为群主" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TeamSection 就地编辑规则", () => {
  it("只改规则与协作说明并带上版本；非法引用不保存", async () => {
    const { onSave } = renderTeam([gate("coordinator", true), gate("rules", true)]);
    fireEvent.click(screen.getByRole("button", { name: "编辑规则" }));
    const rules = screen.getByLabelText(/群聊编排规则/);
    fireEvent.change(rules, { target: { value: "@{ghost} 做事" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(/引用了方案外的成员/).length).toBeGreaterThan(0);
    fireEvent.change(rules, { target: { value: "1. @{qc} 先检验" } });
    fireEvent.change(screen.getByLabelText(/协作说明/), { target: { value: "按批次" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ orchestration_rules: "1. @{qc} 先检验", coordinator_instructions: "按批次", coordinator_key: "lead" });
    expect(onSave.mock.calls[0]![1]).toBe(1);
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
