import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../i18n/context";
import { managerMessages } from "../i18n/messages";
import { SessionContext, type SessionContextValue } from "../auth/session";
import { LoginPage } from "./LoginPage";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

const noopSession: SessionContextValue = {
  session: null,
  token: null,
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function renderLogin(overrides: Partial<SessionContextValue> = {}) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={{ ...noopSession, ...overrides }}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染标题与表单字段", () => {
    renderLogin();
    expect(screen.getByText("AI Team 企业端")).toBeInTheDocument();
    expect(screen.getByText("企业标识（tenant_id）")).toBeInTheDocument();
    expect(screen.getByText("成员账号")).toBeInTheDocument();
    expect(screen.getByText("登录密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("已登录时跳转（不渲染表单）", () => {
    renderLogin({
      session: {
        principal: {
          id: "u1",
          tenant_id: "t1",
          display_name: "u1",
          status: "active",
          roles: ["owner"],
        },
        claims: {
          user_id: "u1",
          tenant_id: "t1",
          roles: ["owner"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    });
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  it("空字段不发请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => {
      expect(screen.getByText("请填写账号与密码")).toBeInTheDocument();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("登录成功 signIn + navigate", async () => {
    const signIn = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { token: "t1", claims: {} } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderLogin({ signIn });
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "tenant1" } });
    fireEvent.change(inputs[1]!, { target: { value: "user1" } });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "pass123" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("t1");
    });
  });

  it("登录失败 401 显示错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          code: "auth_failed",
          detail: "账号或密码错误",
          instance: "/api/auth/login",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
    );
    renderLogin();
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "tenant1" } });
    fireEvent.change(inputs[1]!, { target: { value: "user1" } });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => {
      expect(screen.getByText("账号或密码错误")).toBeInTheDocument();
    });
  });

  it("登录 403 触发 owner-reset 模式，重置成功后 signIn + 跳转", async () => {
    const signIn = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            code: "password_reset_required",
            detail: "password reset required before login",
            instance: "/api/auth/login",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { token: "reset-token", claims: {} } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    renderLogin({ signIn });
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "tenant1" } });
    fireEvent.change(inputs[1]!, { target: { value: "owner1" } });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "bootstrap" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => {
      expect(screen.getByTestId("owner-reset-form")).toBeInTheDocument();
    });
    expect(screen.getByText("首次登录，请设置新密码")).toBeInTheDocument();
    expect(screen.getByText("tenant1 · owner1")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const newPasswordInput = screen.getByTestId("new-password") as HTMLInputElement;
    const confirmPasswordInput = screen.getByTestId("confirm-new-password") as HTMLInputElement;
    fireEvent.change(newPasswordInput, { target: { value: "NewPass!234" } });
    fireEvent.change(confirmPasswordInput, { target: { value: "NewPass!234" } });
    fireEvent.click(screen.getByRole("button", { name: "设置新密码并登录" }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("reset-token");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    expect(secondCallBody).toEqual({
      tenant_id: "tenant1",
      account: "owner1",
      old_password: "bootstrap",
      new_password: "NewPass!234",
    });
  });
});
