/**
 * 回归测试：专家 / 行业解决方案两个注册流程的表单状态隔离（AITEAM-355 问题一）。
 *
 * 两条路由 /experts 与 /industry-solutions 复用同一个 CatalogPage 组件。若不按
 * catalogType 给 CatalogPage 加 key，React 会在切页时复用同一实例，导致注册表单
 * 已填内容（及展开状态）串页污染。此测试驱动真实 App 路由，确保切页后表单被重置。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformRole, createI18n } from "@aiteam/shared";
import { App } from "./App";
import { SessionContext, type SessionContextValue } from "./auth/session";
import { I18nContext } from "./i18n/context";
import { operationMessages } from "./i18n/messages";

const mockFetch = vi.fn();

function makeSystemAdminSession(): SessionContextValue {
  return {
    session: {
      principal: {
        id: "u1",
        display_name: "admin",
        status: "active",
        roles: [PlatformRole.SYSTEM_ADMIN],
      },
      claims: { user_id: "u1", roles: [PlatformRole.SYSTEM_ADMIN], exp: 9999999999 },
    },
    token: "stub-token",
    signIn: vi.fn(),
    signOut: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

function emptyListResponse() {
  return new Response(
    JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function renderApp(initialPath: string) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={makeSystemAdminSession()}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(emptyListResponse());
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
});

describe("注册表单跨页隔离", () => {
  it("从专家页切到行业解决方案页后，注册表单已填内容不串页", async () => {
    renderApp("/experts");

    // 打开专家注册表单并填入一个带毒的值（display_name）。
    // ID 输入框已移除（AITEAM-355 问题二：ID 由服务端自动生成），
    // 用 display_name 代替验证跨页状态被重置。
    const openExpert = await screen.findByRole("button", { name: "注册专家模板" });
    fireEvent.click(openExpert);
    const nameInput = await screen.findByPlaceholderText("display_name");
    fireEvent.change(nameInput, { target: { value: "poison-name" } });
    expect(screen.getByDisplayValue("poison-name")).toBeTruthy();

    // 切换到行业解决方案页（点击侧栏导航）。
    fireEvent.click(screen.getByRole("link", { name: "行业解决方案" }));

    // 到达行业解决方案页：其注册按钮出现。
    await screen.findByRole("button", { name: "注册行业方案" });

    // 关键断言：CatalogPage 已按 key 重挂载 —— 注册面板关闭，脏值消失。
    expect(screen.queryByDisplayValue("poison-name")).toBeNull();
    expect(screen.queryByText("注册新模板/方案")).toBeNull();
  });
});
