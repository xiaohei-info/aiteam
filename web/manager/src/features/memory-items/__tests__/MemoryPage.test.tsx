/**
 * 记忆管理页测试：
 * - 渲染记忆条目列表
 * - 加载失败展示错误
 * - 创建记忆后刷新列表
 * - 删除记忆后刷新列表
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { MemoryPage } from "../MemoryPage";
import * as apiModule from "../useMemoryApi";
import * as expertsModule from "../../experts/useExpertsApi";

vi.mock("../../experts/useExpertsApi", () => ({ useExpertsApi: vi.fn() }));

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const memItem = { memory_id: "m1", employee_id: "emp-1", content: "用户偏好中文回答", category: "preference", importance: 4, source: "manual", created_at: "2026-06-30T10:00:00Z", last_used_at: null };

function mockApi(overrides: Partial<apiModule.MemoryApi> = {}) {
  vi.mocked(expertsModule.useExpertsApi).mockReturnValue({
    listEmployees: vi.fn().mockResolvedValue([{ employee_id: "emp-2", display_name: "专家B" }]),
    listTemplates: vi.fn(), listSolutions: vi.fn(), recruitExpert: vi.fn(), applySolution: vi.fn(),
    updateEmployee: vi.fn(), transitionEmployee: vi.fn(), getLifecycleOptions: vi.fn(), listSolutionInstances: vi.fn(),
  });
  const api: apiModule.MemoryApi = {
    list: vi.fn().mockResolvedValue([memItem]),
    create: vi.fn().mockResolvedValue(memItem),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.spyOn(apiModule, "useMemoryApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <MemoryPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("MemoryPage 记忆管理", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染记忆条目列表", async () => {
    mockApi();
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());
    expect(screen.getByText("用户偏好中文回答")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "记忆管理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 Hindsight 控制台" })).toHaveAttribute("href", "http://localhost:9999/dashboard");
    expect(screen.getByRole("link", { name: "打开 Hindsight 控制台" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开 Hindsight 控制台" })).toHaveAttribute("title", expect.stringContaining("HINDSIGHT_CP_ACCESS_KEY"));
    expect(container.querySelector(".astryx-card")).toBeInTheDocument();
  });

  it("渲染 Hindsight 统计卡片并打开记忆详情", async () => {
    const api = mockApi({
      getAnalytics: vi.fn().mockResolvedValue({
        status: "available", employee_count: 1, total_memory_count: 1,
        refreshed_at: "2026-08-26T00:00:00Z", unavailable_employee_count: 0,
        employees: [{
          employee_id: "emp-2", display_name: "专家B", memory_count: 1,
          state_counts: { valid: 1 }, category_counts: { preference: 1 },
          latest_created_at: "2026-08-26T00:00:00Z", oldest_created_at: "2026-08-26T00:00:00Z",
          latest_used_at: null, average_importance: 0.8, max_importance: 0.8, truncated: false,
        }],
      }),
    });
    renderPage();
    expect(await screen.findByText("记忆总数")).toBeInTheDocument();
    expect(screen.getByText("覆盖 1 位专家")).toBeInTheDocument();
    await waitFor(() => expect(api.getAnalytics).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "查看详情m1" }));
    expect(await screen.findByRole("dialog", { name: "记忆详情 · m1" })).toBeInTheDocument();
    expect(screen.getAllByText(/状态：valid/).length).toBeGreaterThan(0);
  });

  it("加载失败展示错误", async () => {
    mockApi({ list: vi.fn().mockRejectedValue(new ApiError("记忆服务不可用", 503, "memory_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("记忆服务不可用"));
  });

  it("创建记忆后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());

    fireEvent.click(screen.getByText("+ 新增记忆"));
    fireEvent.click(screen.getByRole("combobox", { name: /专家/ }));
    const expertOptions = screen.getAllByRole("option", { name: "专家B", hidden: true });
    fireEvent.click(expertOptions[expertOptions.length - 1]!);
    fireEvent.change(screen.getByLabelText("记忆内容"), { target: { value: "新记忆内容" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ employee_id: "emp-2", content: "新记忆内容" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("编辑记忆后刷新列表并带员工授权范围", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());

    fireEvent.click(screen.getByText("编辑"));
    fireEvent.change(screen.getByLabelText("记忆内容"), { target: { value: "已更新记忆" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith("m1", { content: "已更新记忆" }, "emp-1"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("删除记忆后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());

    fireEvent.click(screen.getByText("删除"));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("m1", "emp-1"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
