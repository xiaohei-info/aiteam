/**
 * LoginPage 组件测试：渲染标题、提交触发 client.login。
 *
 * 用 jsdom + @testing-library/react。client 由 AppProvider 注入（基于 mock fetch）。
 * 不渲染顶层 <App/>（含 BrowserRouter），改用 MemoryRouter + AppProvider + AppRoutes，
 * 避免 Router 嵌套。
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AppProvider } from "../lib/app-context";
import { AppRoutes } from "../app/routes";

// mock fetch：/api/agent/login 成功返回 token+claims
function mockFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.endsWith("/api/agent/login")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const claims = {
        user_id: body.account,
        tenant_id: "t-1",
        enterprise_id: null,
        roles: ["member"],
        exp: 9999999999,
      };
      return new Response(JSON.stringify({ data: { token: "tok-x", claims } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  }) as unknown as ReturnType<typeof vi.fn>;
}

const originalFetch = globalThis.fetch;

describe("LoginPage", () => {
  it("渲染标题与三个字段", () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    try {
      render(
        <MemoryRouter initialEntries={["/login"]}>
          <AppProvider>
            <AppRoutes />
          </AppProvider>
        </MemoryRouter>,
      );
      // 标题与提交按钮文案都含「登录」，按 role=heading 精确取标题
      expect(screen.getByRole("heading", { level: 1, name: "登录" })).toBeInTheDocument();
      expect(screen.getByLabelText("账号（手机号 / 用户名）")).toBeInTheDocument();
      expect(screen.getByLabelText("密码")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("提交成功后调用 login（命中 /api/agent/login）", async () => {
    const fetchImpl = mockFetch();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      render(
        <MemoryRouter initialEntries={["/login"]}>
          <AppProvider>
            <AppRoutes />
          </AppProvider>
        </MemoryRouter>,
      );
      fireEvent.change(screen.getByLabelText("账号（手机号 / 用户名）"), {
        target: { value: "alice" },
      });
      fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw" } });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));

      await waitFor(() => {
        expect(fetchImpl).toHaveBeenCalled();
      });
      const calls = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map((c) => c[0]);
      expect(calls.some((c) => c.endsWith("/api/agent/login"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
