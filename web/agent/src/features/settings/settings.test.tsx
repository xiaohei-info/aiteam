/**
 * 设置页测试（agent）：
 * - 未登录时账号 Tab 展示「不可用」。
 * - 登录后展示账号字段（用户ID/角色/Token过期时间）。
 * - 偏好 Tab 支持切换语言（同步到 i18n + localStorage）。
 * - 安全 Tab 退出登录按钮连接 useApp().logout。
 * - 安全 Tab 重新同步按钮调用本端 /api/agent/grants/sync 并展示结果。
 */

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../../lib/app-context";
import { SettingsPage } from "./SettingsPage";

const validClaims = {
  user_id: "u-1",
  tenant_id: "t-1",
  enterprise_id: "e-1",
  roles: ["member"],
  // 2099-01-01
  exp: 4070908800,
};

function loginStorage(claims = validClaims) {
  localStorage.setItem("aiteam.agent.token", "t");
  localStorage.setItem("aiteam.agent.claims", JSON.stringify(claims));
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <SettingsPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

/** mock fetch：对 grants 同步端点返回指定结果，其余返回空 envelope。 */
function mockFetch(result: { ok: boolean; upserted: number; revoked: number; error?: string | null }) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.includes("/api/agent/grants/sync") && init?.method === "POST") {
      return new Response(JSON.stringify({ data: result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("SettingsPage", () => {
  it("未登录时账号 Tab 显示不可用占位", async () => {
    renderPage();
    expect(await screen.findByText("账号信息")).toBeInTheDocument();
    expect(screen.getByText(/未登录/)).toBeInTheDocument();
  });

  it("登录后账号 Tab 渲染用户字段（user_id、tenant、roles、过期时间）", async () => {
    loginStorage();
    renderPage();
    expect(await screen.findByText("账号信息")).toBeInTheDocument();

    expect(screen.getAllByText("u-1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("t-1")).toBeInTheDocument();
    expect(screen.getByText("member")).toBeInTheDocument();
    expect(screen.getByText(/2099/)).toBeInTheDocument();
  });

  it("偏好 Tab：选「English」后切换 i18n locale + 持久化到 localStorage", async () => {
    loginStorage();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "偏好" }));

    const localeSelect = screen.getByLabelText("语言") as HTMLSelectElement;
    await waitFor(() => expect(localeSelect).toBeInTheDocument());

    fireEvent.change(localeSelect, { target: { value: "en-US" } });

    await waitFor(() => {
      const raw = localStorage.getItem("aiteam.agent.preferences");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).locale).toBe("en-US");
    });
  });

  it("安全 Tab：点击退出登录清除本机登录态", async () => {
    loginStorage();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "安全" }));

    const logoutBtn = await screen.findByRole("button", { name: "退出登录" });
    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(localStorage.getItem("aiteam.agent.token")).toBeNull();
    });
  });

  it("安全 Tab：重新同步成功后展示结果摘要", async () => {
    globalThis.fetch = mockFetch({ ok: true, upserted: 3, revoked: 1, error: null });
    loginStorage();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "安全" }));

    const syncBtn = await screen.findByRole("button", { name: "立即同步" });
    fireEvent.click(syncBtn);

    expect(await screen.findByText(/同步成功/)).toBeInTheDocument();
    expect(screen.getByText(/新增 3，撤销 1/)).toBeInTheDocument();
  });

  it("安全 Tab：重新同步失败后展示错误", async () => {
    globalThis.fetch = mockFetch({ ok: false, upserted: 0, revoked: 0, error: "boom" });
    loginStorage();
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "安全" }));

    const syncBtn = await screen.findByRole("button", { name: "立即同步" });
    fireEvent.click(syncBtn);

    expect(await screen.findByText(/同步失败/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
