import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { MarketplacePage } from "../MarketplacePage";
import { useExpertsApi } from "../../experts/useExpertsApi";

vi.mock("../../experts/useExpertsApi", () => ({ useExpertsApi: vi.fn() }));

import type { ExpertsApi } from "../../experts/useExpertsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(roles: string[]): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

function mockApi(): ExpertsApi {
  const api: ExpertsApi = {
    listTemplates: vi.fn().mockResolvedValue([{ template_id: "tpl-1", version: "1", display_name: "测试专家" }]),
    listSolutions: vi.fn().mockResolvedValue([]),
    recruitExpert: vi.fn().mockResolvedValue({}),
    applySolution: vi.fn().mockResolvedValue({}),
    listEmployees: vi.fn().mockResolvedValue([]),
    updateEmployee: vi.fn().mockResolvedValue(null),
    listSolutionInstances: vi.fn().mockResolvedValue([]),
    transitionEmployee: vi.fn().mockResolvedValue(null),
    getLifecycleOptions: vi.fn().mockResolvedValue({ actions: [] }),
  };
  (useExpertsApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter><MarketplacePage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("MarketplacePage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("浏览：渲染可招募专家模板", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "人才市场" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "测试专家" })).toBeInTheDocument();
  });

  it("搜索与状态筛选只展示匹配的数字员工卡片", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { template_id: "tpl-1", version: "1", display_name: "客服专家", persona: "处理客户咨询" },
      { template_id: "tpl-2", version: "2", display_name: "研究专家", persona: "分析行业趋势", is_recruited: true },
    ]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getAllByTestId("template-row")).toHaveLength(2));

    fireEvent.change(screen.getByRole("textbox", { name: "搜索专家" }), { target: { value: "客服" } });
    expect(screen.getAllByTestId("template-row")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "客服专家" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "搜索专家" }), { target: { value: "" } });
    fireEvent.click(within(screen.getByRole("group", { name: "人才市场筛选" })).getByRole("button", { name: "已招募" }));
    expect(screen.queryByRole("article", { name: "客服专家" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "研究专家" })).toBeInTheDocument();
  });

  it("招募：直接点击招募按钮 → recruitExpert(template_id，无 slug)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1" }));
  });

  it("招募先完成部门设置，并把所选部门传给后端", async () => {
    const api = mockApi();
    api.listDepartments = vi.fn().mockResolvedValue([{ id: "d1", display_name: "研发部" }]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "招募" }));
    const dialog = await screen.findByRole("dialog", { name: "招募测试专家" });
    await waitFor(() => expect(api.listDepartments).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole("combobox", { name: "所属部门" }));
    fireEvent.click(screen.getByRole("option", { name: "研发部", hidden: true }));
    fireEvent.click(within(dialog).getByRole("button", { name: "招募" }));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1", department_ids: ["d1"] }));
  });

  it("部门设置允许显式选择未设置", async () => {
    const api = mockApi();
    api.listDepartments = vi.fn().mockResolvedValue([]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "招募" }));
    const dialog = await screen.findByRole("dialog", { name: "招募测试专家" });
    expect(within(dialog).getByRole("option", { name: "未设置", hidden: true })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "招募" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "招募" }));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1", department_ids: [] }));
  });

  it("只读角色（member）不显示招募入口", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.queryByText("招募")).not.toBeInTheDocument();
  });

  it("不再显示实例标识（slug）输入框", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.queryByLabelText("实例标识（slug）")).not.toBeInTheDocument();
  });

  it("加载失败：listTemplates 报错显示错误信息", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("加载失败"))).toBe(true));
  });

  it("空状态：无模板时显示空提示", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无可招募模板")).toBeInTheDocument());
  });

  it("已招募模板显示已招募且不可再点", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { template_id: "tpl-1", version: "1", display_name: "测试专家", is_recruited: true },
    ]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getAllByText("已招募").length).toBeGreaterThan(0));
    expect(screen.queryByText("招募")).not.toBeInTheDocument();
    expect(api.recruitExpert).not.toHaveBeenCalled();
  });

  it("招募成功：显示成功提示", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1" }));
    await waitFor(() => expect(screen.getByText("招募成功")).toBeInTheDocument());
  });

  it("招募失败：recruitExpert 报错显示操作失败", async () => {
    const api = mockApi();
    (api.recruitExpert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeInTheDocument());
  });


  it("卡片显示一句话定位、标签上限与最多 3 项指标；样本不足不显示解决率", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        template_id: "tpl-1", version: "1", display_name: "客服专家", description: "长描述",
        tagline: "售后问题一站解决", tags: ["客服", "售后", "退款", "物流"], output_types: ["document"],
        pricing: { mode: "per_call", unit_price: "0.05", currency: "USD" },
        stats: { resolution_rate: 0.85, evaluated_segments: 40, resolved_segments: 34, min_sample: 10 },
        platform_skill_refs: [{ skill_id: "s1", version: "1", content_hash: "h" }],
        platform_model_ref: { provider_id: "p", provider_version: 1, model_id: "gpt-5", model_version: 1 },
      },
      {
        template_id: "tpl-2", version: "1", display_name: "研究专家",
        stats: { resolution_rate: null, evaluated_segments: 3, resolved_segments: 0, min_sample: 10 },
      },
    ]);
    renderPage(["owner"]);
    const card = await screen.findByRole("article", { name: "客服专家" });
    expect(within(card).getByText("售后问题一站解决")).toBeInTheDocument();
    expect(within(card).getByText("+1")).toBeInTheDocument();
    expect(within(card).queryByText("物流")).not.toBeInTheDocument();
    expect(within(card).getByText("85%")).toBeInTheDocument();
    expect(within(card).getByText("$0.05/次")).toBeInTheDocument();
    expect(within(card).queryByText("gpt-5")).not.toBeInTheDocument();

    const sparse = screen.getByRole("article", { name: "研究专家" });
    expect(within(sparse).queryByText("解决率")).not.toBeInTheDocument();
    expect(within(sparse).queryByText(/0%/)).not.toBeInTheDocument();
    expect(sparse.querySelectorAll('[data-ui="expert-card-meta"] > span')).toHaveLength(3);
  });

  it("详情按四个标签页展示字段，样本不足显示说明，接入要求为空显示无需额外配置", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([{
      template_id: "tpl-1", version: "2", display_name: "测试专家",
      tagline: "售后问题一站解决", use_cases: ["退款处理"], example_prompts: ["帮我写退款话术"],
      stats: { resolution_rate: null, evaluated_segments: 3, resolved_segments: 0, min_sample: 10 },
      publisher: "平台运营",
    }]);
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    const dialog = await screen.findByRole("dialog", { name: "测试专家详情" });
    expect(within(dialog).getByText("退款处理")).toBeInTheDocument();
    expect(within(dialog).getByText("帮我写退款话术")).toBeInTheDocument();
    expect(within(dialog).queryByText("不适用")).not.toBeInTheDocument();
    expect(within(dialog).getByText("发布者：平台运营")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "接入要求" }));
    expect(within(dialog).getByText("无需额外配置")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "数据与成本" }));
    expect(within(dialog).getByText("样本不足（已评估 3 段，满 10 段后显示）")).toBeInTheDocument();
    expect(within(dialog).queryByText(/数据未提供/)).not.toBeInTheDocument();
  });

  it("招募成功：显示前往专家实例配置入口", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(screen.getByTestId("goto-experts")).toBeInTheDocument());
    expect(screen.getByTestId("goto-experts")).toHaveAttribute("href", "/experts");
  });
});
