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
    if (path.endsWith("/api/auth/resolve-tenant-by-account")) {
      return new Response(JSON.stringify({ data: { tenant_id: "t-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.endsWith("/api/agent/login")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body).toMatchObject({ tenant_id: "t-1" });
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

// mock fetch：/api/agent/login 返回 403 problem+json（must_reset → 重置模式）
function mockFetchForbidden(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const path = typeof url === "string" ? url : url.toString();
    if (path.endsWith("/api/auth/resolve-tenant-by-account")) {
      return new Response(JSON.stringify({ data: { tenant_id: "t-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.endsWith("/api/agent/login")) {
      return new Response(
        JSON.stringify({
          code: "agent_must_reset",
          title: "Must reset password",
          detail: "首次登录，请设置新密码",
          status: 403,
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/problem+json" },
        },
      );
    }
    return new Response(JSON.stringify({ data: null }), { status: 200 });
  }) as unknown as ReturnType<typeof vi.fn>;
}

const originalFetch = globalThis.fetch;

describe("LoginPage", () => {
  it("渲染登录字段，支持同账号多企业时填写企业", () => {
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
    try {
      render(
        <MemoryRouter initialEntries={["/login"]}>
          <AppProvider>
            <AppRoutes />
          </AppProvider>
        </MemoryRouter>,
      );
      expect(screen.getByRole("heading", { level: 1, name: "登录" })).toBeInTheDocument();
      expect(screen.getByRole("form", { name: "用户端登录" })).toBeInTheDocument();
      expect(screen.getByLabelText("账号（手机号 / 用户名）")).toBeInTheDocument();
      expect(screen.getByLabelText("企业代码/名称（同账号多企业时填写）")).toBeInTheDocument();
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
      fireEvent.change(screen.getByLabelText("企业代码/名称（同账号多企业时填写）"), { target: { value: "acme" } });
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

  it("登录返回 403 时切到重置模式并显示账号（覆盖 reset shell {account} 段落）", async () => {
    globalThis.fetch = mockFetchForbidden() as unknown as typeof fetch;
    try {
      render(
        <MemoryRouter initialEntries={["/login"]}>
          <AppProvider>
            <AppRoutes />
          </AppProvider>
        </MemoryRouter>,
      );
      const account = "alice";
      fireEvent.change(screen.getByLabelText("账号（手机号 / 用户名）"), {
        target: { value: account },
      });
      fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw" } });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));

      // 403 → 切换 reset 模式，重绘为重置表单（reset_heading 出现）。
      await waitFor(() => {
        expect(screen.getByText("首次登录，请设置新密码")).toBeInTheDocument();
      });
      // 重置视图必须保留账号上下文；具体标签由 Astryx Text 决定，不能绑死历史 DOM。
      expect(screen.getByText(account)).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("重置提交发送 tenant_id 与 old_password", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/auth/resolve-tenant-by-account")) {
        return new Response(JSON.stringify({ data: { tenant_id: "t-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path.endsWith("/api/agent/login")) {
        return new Response(JSON.stringify({ code: "agent_must_reset", status: 403, detail: "首次登录，请设置新密码" }), { status: 403, headers: { "Content-Type": "application/problem+json" } });
      }
      expect(path).toContain("/api/agent/reset-password");
      expect(JSON.parse(String(init?.body))).toEqual({ account: "alice", tenant_id: "t-1", old_password: "bootstrap", new_password: "fresh-password" });
      return new Response(JSON.stringify({ data: { token: "tok-reset", claims: { user_id: "alice", tenant_id: "t-1", roles: [], exp: 9999999999 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      render(<MemoryRouter initialEntries={["/login"]}><AppProvider><AppRoutes /></AppProvider></MemoryRouter>);
      fireEvent.change(screen.getByLabelText("账号（手机号 / 用户名）"), { target: { value: "alice" } });
      fireEvent.change(screen.getByLabelText("密码"), { target: { value: "bootstrap" } });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      await waitFor(() => expect(screen.getByText("首次登录，请设置新密码")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "fresh-password" } });
      fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "fresh-password" } });
      fireEvent.click(screen.getByRole("button", { name: "设置新密码并登录" }));
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/api/agent/reset-password"), expect.anything()));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
