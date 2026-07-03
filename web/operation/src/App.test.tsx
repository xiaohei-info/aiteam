/**
 * App 路由测试：验证菜单拆分后的 /experts、/industry-solutions 路由
 * 以及旧 /catalog 重定向均可达。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformRole, createI18n, sharedMessages } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "./auth/session";
import { I18nContext } from "./i18n/context";
import { operationMessages } from "./i18n/messages";

// Mock page components to avoid API calls; we only test routing.
vi.mock("./features/catalog", () => ({
  CatalogPage: ({ catalogType }: { catalogType: string }) => (
    <div data-testid="catalog-page" data-catalog-type={catalogType} />
  ),
  CatalogDetailPage: () => <div data-testid="catalog-detail" />,
}));
vi.mock("./features/board", () => ({
  BoardPage: () => <div data-testid="board" />,
  EnterpriseDetailPage: () => <div data-testid="board-detail" />,
}));
vi.mock("./features/enterprise", () => ({
  EnterprisePage: () => <div data-testid="enterprise" />,
}));
vi.mock("./EnterprisePageWired", () => ({
  EnterprisePageWired: () => <div data-testid="enterprise-wired" />,
}));
vi.mock("./features/accounts", () => ({
  AccountsPage: () => <div data-testid="accounts" />,
}));
vi.mock("./features/finance", () => ({
  FinancePage: () => <div data-testid="finance" />,
}));
vi.mock("./features/solutions", () => ({
  SolutionsPage: () => <div data-testid="solutions" />,
}));
vi.mock("./features/system-health", () => ({
  SystemHealthPage: () => <div data-testid="health" />,
}));
vi.mock("./pages/DashboardPlaceholder", () => ({
  DashboardPlaceholder: () => <div data-testid="dashboard" />,
}));
vi.mock("./pages/LoginPage", () => ({
  LoginPage: () => <div data-testid="login" />,
}));

// App must be imported AFTER mocks are set up.
import { App } from "./App";

function makeSession(): SessionContextValue {
  return {
    session: {
      principal: {
        id: "u1",
        display_name: "admin",
        status: "active",
        roles: [PlatformRole.SYSTEM_ADMIN],
      },
      claims: {
        user_id: "u1",
        roles: [PlatformRole.SYSTEM_ADMIN],
        exp: 9999999999,
      },
    },
    token: "stub-token",
    signIn: vi.fn(),
    signOut: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function renderApp(initialPath: string) {
  const i18n = makeI18n();
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={makeSession()}>
        <MemoryRouter initialEntries={[initialPath]}>
          <App />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("App 路由 — 菜单拆分", () => {
  it("/experts 渲染专家页（catalogType=expert_template）", async () => {
    renderApp("/experts");
    await waitFor(() => {
      const el = screen.getByTestId("catalog-page");
      expect(el.getAttribute("data-catalog-type")).toBe("expert_template");
    });
  });

  it("/industry-solutions 渲染行业方案页（catalogType=solution_template）", async () => {
    renderApp("/industry-solutions");
    await waitFor(() => {
      const el = screen.getByTestId("catalog-page");
      expect(el.getAttribute("data-catalog-type")).toBe("solution_template");
    });
  });

  it("旧 /catalog 重定向到 /experts", async () => {
    renderApp("/catalog");
    await waitFor(() => {
      const el = screen.getByTestId("catalog-page");
      expect(el.getAttribute("data-catalog-type")).toBe("expert_template");
    });
  });
});
