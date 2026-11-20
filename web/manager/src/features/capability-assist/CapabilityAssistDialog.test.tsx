import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@aiteam/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityAssistDialog } from "./CapabilityAssistDialog";
import { mcpDialogInitial, readHandoff, skillImportInitial } from "./handoff";
import type { CapabilityAssistCandidate, CapabilityAssistResult } from "./types";

const models = {
  providers: [],
  models: [{
    model: { provider_id: "p1", model_id: "m1", display_name: "m1", status: "published", version: 1 },
    rate: { pricing_status: "known", input_usd_per_million: "1", output_usd_per_million: "2" },
  }],
};
const modelsApi = { list: async () => models };
vi.mock("../platform-models/usePlatformModelsApi", () => ({ usePlatformModelsApi: () => modelsApi }));

const skill: CapabilityAssistCandidate = {
  kind: "skill", source: "clawhub", url: "https://clawhub.ai/alice/skills/minutes", title: "会议纪要", summary: "把录音整理成纪要",
  reason: "下载量高", verified: true,
  security: { status: "suspicious", has_warnings: true, scanners: [{ name: "llm", status: "suspicious" }] },
};
const mcp: CapabilityAssistCandidate = {
  kind: "mcp", source: "config", url: "https://erp.example.com/mcp", title: "ERP 订单", summary: "查订单", reason: "管理员给的", verified: false,
};

const result = (extra: Partial<CapabilityAssistResult> = {}): CapabilityAssistResult => ({
  candidates: [skill, mcp], notes: "找到两个", incomplete: false, dropped: 1, error: null, rounds: 3, tool_calls: 4,
  usage: { input_tokens: 1000, output_tokens: 200, cost: "0.0036", pricing_status: "known" }, ...extra,
});

const api = { find: vi.fn() };
beforeEach(() => vi.clearAllMocks());

async function fillAndFind(onUse = vi.fn()) {
  render(<CapabilityAssistDialog api={api} onClose={vi.fn()} onUse={onUse} />);
  const start = screen.getByRole("button", { name: "开始查找" });
  expect(start).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/需求/), { target: { value: "  整理会议录音  " } });
  fireEvent.change(screen.getByLabelText(/已知链接/), { target: { value: "https://clawhub.ai/alice/skills/minutes" } });
  // 只有一个模型时自动选上，开始查找变为可点。
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  return onUse;
}

describe("CapabilityAssistDialog", () => {
  it("提交需求与所选模型；结果显示候选、丢弃数与用量，「用这个」交出候选", async () => {
    api.find.mockResolvedValue(result());
    const onUse = await fillAndFind();
    await screen.findByLabelText("候选 会议纪要");
    expect(api.find).toHaveBeenCalledWith({
      requirement: "整理会议录音", link: "https://clawhub.ai/alice/skills/minutes", model: { provider_id: "p1", model_id: "m1" },
    });
    const card = screen.getByLabelText("候选 会议纪要");
    for (const label of ["技能", "ClawHub", "已核实", "模型复核：有可疑项"]) expect(within(card).getByText(label)).toBeInTheDocument();
    expect(within(screen.getByLabelText("候选 ERP 订单")).getByText("未核实")).toBeInTheDocument();
    expect(screen.getByText(/另有 1 个候选的链接不在查找结果里/)).toBeInTheDocument();
    expect(screen.getByText(/输入 1000 \/ 输出 200 tokens/)).toHaveTextContent("费用 $0.0036");
    fireEvent.click(within(screen.getByLabelText("候选 ERP 订单")).getByRole("button", { name: "用这个" }));
    expect(onUse).toHaveBeenCalledWith(mcp);
  });

  it("中途出错：提示未完成并给出已找到的结果；没有候选时提示换个说法", async () => {
    api.find.mockResolvedValue(result({ candidates: [], dropped: 0, incomplete: true, error: "relay 503", usage: { input_tokens: 10, output_tokens: 0, cost: null, pricing_status: "unknown" } }));
    await fillAndFind();
    expect(await screen.findByText("查找没有完全结束")).toBeInTheDocument();
    expect(screen.getByText(/relay 503/)).toBeInTheDocument();
    expect(screen.getByText(/没有找到合适的候选/)).toBeInTheDocument();
    expect(screen.getByText(/价格未知/)).toBeInTheDocument();
  });

  it("失败时留在表单并显示原因；「重新查找」回到表单且保留需求", async () => {
    api.find.mockRejectedValueOnce(new ApiError("x", 404, "not_found"));
    await fillAndFind();
    expect(await screen.findByText("本企业没有这个模型，请重新选择")).toBeInTheDocument();
    expect(screen.getByLabelText(/需求/)).toHaveValue("  整理会议录音  ");

    api.find.mockResolvedValueOnce(result());
    fireEvent.click(screen.getByRole("button", { name: "开始查找" }));
    await screen.findByLabelText("候选 会议纪要");
    fireEvent.click(screen.getByRole("button", { name: "重新查找" }));
    expect(screen.getByLabelText(/需求/)).toHaveValue("  整理会议录音  ");
  });
});

describe("handoff", () => {
  it("技能候选按来源进导入对话框；MCP 候选预填地址与名称；kind 不匹配不交接", () => {
    expect(skillImportInitial(skill)).toEqual({ source: "clawhub", url: skill.url });
    expect(skillImportInitial({ ...skill, source: "github" })).toEqual({ source: "url", url: skill.url });
    expect(mcpDialogInitial(mcp)).toEqual({ url: mcp.url, display_name: "ERP 订单", summary: "查订单" });
    expect(readHandoff({ assistCandidate: skill }, "skill")).toBe(skill);
    expect(readHandoff({ assistCandidate: skill }, "mcp")).toBeNull();
    expect(readHandoff(null, "skill")).toBeNull();
  });
});
