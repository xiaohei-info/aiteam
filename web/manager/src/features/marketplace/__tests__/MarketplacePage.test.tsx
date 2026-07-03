import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    updateSolutionInstance: vi.fn().mockResolvedValue(null),
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
  });

  it("招募：填 slug → recruitExpert(template_id + slug)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("实例标识（slug）"), { target: { value: "exp-new" } });
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1", employee_slug: "exp-new" }));
  });

  it("只读角色（member）不显示招募入口", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    expect(screen.queryByText("招募")).not.toBeInTheDocument();
  });

  it("加载失败：listTemplates 报错显示错误信息", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("加载失败")).toBeInTheDocument());
  });

  it("空状态：无模板时显示空提示", async () => {
    const api = mockApi();
    (api.listTemplates as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无可招募模板")).toBeInTheDocument());
  });

  it("招募成功：显示成功提示并清空 slug 输入", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("实例标识（slug）"), { target: { value: "exp-ok" } });
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(api.recruitExpert).toHaveBeenCalledWith({ template_id: "tpl-1", employee_slug: "exp-ok" }));
    await waitFor(() => expect(screen.getByText("招募成功")).toBeInTheDocument());
    expect(screen.getByLabelText("实例标识（slug）")).toHaveValue("");
  });

  it("招募失败：recruitExpert 报错显示操作失败", async () => {
    const api = mockApi();
    (api.recruitExpert as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("测试专家")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("实例标识（slug）"), { target: { value: "exp-x" } });
    fireEvent.click(screen.getByText("招募"));
    await waitFor(() => expect(screen.getByText("操作失败，请重试")).toBeInTheDocument());
  });
});
