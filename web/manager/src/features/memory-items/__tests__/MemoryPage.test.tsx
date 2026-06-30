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
  const api: apiModule.MemoryApi = {
    list: vi.fn().mockResolvedValue([memItem]),
    create: vi.fn().mockResolvedValue(memItem),
    update: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    bulkDelete: vi.fn().mockResolvedValue(undefined),
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
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());
    expect(screen.getByText("用户偏好中文回答")).toBeInTheDocument();
  });

  it("加载失败展示错误", async () => {
    mockApi({ list: vi.fn().mockRejectedValue(new ApiError("记忆服务不可用", 503, "memory_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("记忆服务不可用")).toBeInTheDocument());
  });

  it("创建记忆后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());

    fireEvent.click(screen.getByText("+ 新增记忆"));
    fireEvent.change(screen.getByLabelText("员工ID"), { target: { value: "emp-2" } });
    fireEvent.change(screen.getByLabelText("记忆内容"), { target: { value: "新记忆内容" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ employee_id: "emp-2", content: "新记忆内容" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("删除记忆后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("memory-item")).toBeInTheDocument());

    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
