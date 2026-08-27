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
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("加载失败"));
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


  it("招募成功：显示前往专家实例配置入口", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(screen.getByTestId("goto-experts")).toBeInTheDocument());
    expect(screen.getByTestId("goto-experts")).toHaveAttribute("href", "/experts");
  });
});
