import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { applyCapabilities, CapabilitiesSection } from "./CapabilitiesSection";
import type { GeneratedSolution } from "./types";

const internal = [
  { skill_id: "ps-1", owner: "acme", slug: "sheet", display_name: "读表", summary: "", published_version: "2", content_hash: "h2", status: "published" },
  { skill_id: "ps-draft", owner: "acme", slug: "draft", display_name: "草稿技能", summary: "", published_version: null, content_hash: null, status: "draft" },
];
const external = [{ owner: "claw", slug: "report", display_name: "写报告", summary: "生成报告", latest_version: "1.0.0", downloads: 3, canonical_url: "https://clawhub.ai/claw/skills/report" }];
const download = vi.fn();
vi.mock("../skill-market/useSkillMarketApi", () => ({
  useSkillMarketApi: () => ({
    listInternal: async () => internal,
    listExternal: async () => external,
    download: (...args: unknown[]) => download(...args),
  }),
}));

const expert = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key, display_name: name, category: "质检", description: "d", system_prompt: "p", evidence: [], ...extra,
});
function solution(): GeneratedSolution {
  return {
    display_name: "方案", description: "d", tags: [], coordinator_key: "lead", coordinator_instructions: "",
    output_requirements: "", evidence: [], mode: "group", orchestration_rules: "",
    experts: [
      expert("lead", "协调员", { skills: [{ skill_id: "ps-1", version: "1", content_hash: "h1", reason: "旧版" }], mcps: [{ key: "mes", display_name: "MES", purpose: "", required: false }] }),
      expert("qc", "质检员", { mcps: [{ key: "mes", display_name: "MES", purpose: "", required: false }] }),
    ],
  } as unknown as GeneratedSolution;
}

describe("applyCapabilities", () => {
  it("移除项从所有专家上去掉；新增 skill 挂到目标专家，同一 skill 换成新版本", () => {
    const next = applyCapabilities(solution(), {
      removed: ["mcp:mes"], target: "lead",
      added: [{ skill_id: "ps-1", version: "2", content_hash: "h2" }, { skill_id: "clawhub-x", version: "1", content_hash: "hx" }],
    });
    expect(next.experts.map((e) => e.mcps)).toEqual([[], []]);
    expect(next.experts[0]!.skills).toEqual([
      { skill_id: "ps-1", version: "2", content_hash: "h2", reason: "" },
      { skill_id: "clawhub-x", version: "1", content_hash: "hx", reason: "" },
    ]);
    expect(next.experts[1]!.skills ?? []).toEqual([]);
  });
});

describe("CapabilitiesSection 添加 skill", () => {
  function renderSection() {
    const onSave = vi.fn().mockResolvedValue(null);
    render(
      <CapabilitiesSection
        solution={solution()} version={7} canEdit busy={false}
        active={null} onActiveChange={() => {}} onSave={onSave}
      />,
    );
    return { onSave };
  }

  it("从 ClawHub 导入并选择后推荐给指定专家；保存只带本节改动与版本", async () => {
    download.mockResolvedValue({ skill_id: "clawhub-claw-report", version: "1.0.0", content_hash: "hr", status: "published" });
    const { onSave } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "编辑能力清单" }));
    expect(await screen.findByTestId("capability-add")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ClawHub 外部市场" }));
    fireEvent.click(await screen.findByRole("button", { name: "下载并选择" }));
    expect(await screen.findByText(/保存后新增：clawhub-claw-report v1.0.0/)).toBeInTheDocument();
    expect(download).toHaveBeenCalledWith("claw", "report", "1.0.0");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [next, version] = onSave.mock.calls[0]!;
    expect(version).toBe(7);
    // 默认推荐给群主。
    expect(next.experts[0].skills.map((s: { skill_id: string }) => s.skill_id)).toEqual(["ps-1", "clawhub-claw-report"]);
  });

  it("导入后未开放的 skill 不会被选中，并说明要先在技能市场开放", async () => {
    download.mockResolvedValue({ skill_id: "clawhub-claw-report", version: "1.0.0", content_hash: "hr", status: "draft" });
    const { onSave } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "编辑能力清单" }));
    fireEvent.click(await screen.findByRole("button", { name: "ClawHub 外部市场" }));
    fireEvent.click(await screen.findByRole("button", { name: "下载并选择" }));
    expect(await screen.findByText(/在技能市场开放后才能添加到方案/)).toBeInTheDocument();
    expect(screen.queryByText(/保存后新增/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].experts[0].skills).toHaveLength(1);
  });
});

describe("CapabilitiesSection 展示", () => {
  it("skill 按内部技能市场的名称和版本展示，而不是平台 skill_id", async () => {
    render(
      <CapabilitiesSection
        solution={solution()} version={7} canEdit busy={false}
        active={null} onActiveChange={() => {}} onSave={vi.fn()}
      />,
    );
    expect(await screen.findByText("skill · 读表 v1")).toBeInTheDocument();
    expect(screen.queryByText(/skill · ps-1/)).not.toBeInTheDocument();
  });
});

