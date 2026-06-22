import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../i18n/context";
import { operationMessages } from "../i18n/messages";
import { SessionContext, type SessionContextValue } from "../auth/session";
import { LoginPage } from "./LoginPage";

const mockFetch = vi.fn();

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
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

function okResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function problemResponse(status: number, code: string, detail: string) {
  return new Response(
    JSON.stringify({ type: "about:blank", title: "error", status, code, detail }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch;
});

afterEach(() => {
  delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
});

describe("LoginPage", () => {
  it("渲染标题与表单字段", () => {
    renderLogin();
    expect(screen.getByText("AI Team 运营端")).toBeInTheDocument();
    expect(screen.getByText("用户名")).toBeInTheDocument();
    expect(screen.getByText("密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("已登录时跳转（不渲染表单）", () => {
    renderLogin({
      session: {
        principal: {
          id: "u1",
          display_name: "u1",
          status: "active",
          roles: ["system_admin"],
        },
        claims: {
          user_id: "u1",
          roles: ["system_admin"],
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    });
    expect(screen.queryByTestId("login-form")).toBeNull();
  });

  it("空字段不发请求", () => {
    renderLogin();
    fireEvent.submit(screen.getByTestId("login-form"));
    expect(screen.getByText("请填写用户名与密码")).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("登录成功 signIn + navigate", async () => {
    const signIn = vi.fn();
    renderLogin({ signIn });

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "admin" } });
    // password input may render as textbox in jsdom
    const pwd = screen.getAllByLabelText("密码")[0]!;
    fireEvent.change(pwd, { target: { value: "pass" } });

    mockFetch.mockResolvedValueOnce(okResponse({ token: "tok-123" }));

    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("tok-123");
    });

    const loginCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes("/api/operation/auth/login"),
    );
    expect(loginCall).toBeDefined();
  });

  it("登录失败 401 显示错误", async () => {
    renderLogin();

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "admin" } });
    const pwd = screen.getAllByLabelText("密码")[0]!;
    fireEvent.change(pwd, { target: { value: "wrong" } });

    mockFetch.mockResolvedValueOnce(
      problemResponse(401, "invalid_credentials", "用户名或密码错误"),
    );

    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(screen.getByText("用户名或密码错误")).toBeInTheDocument();
    });
  });
});
