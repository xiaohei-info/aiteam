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
    expect(screen.getByRole("form", { name: "企业端登录" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "企业代码/名称" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "成员账号" })).toBeInTheDocument();
    expect(screen.getByLabelText("登录密码")).toBeInTheDocument();
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
      expect(screen.getByRole("alert")).toHaveTextContent("请填写账号与密码");
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("登录成功 signIn + navigate", async () => {
    const signIn = vi.fn();
    // 两段式登录(2127dab):先 resolve-tenant 再 login,按序 mock 两个响应。
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { tenant_id: "t-uuid-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
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
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { tenant_id: "t-uuid-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
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
      expect(screen.getByRole("alert")).toHaveTextContent("账号或密码错误");
    });
  });

  it.each(["password_reset_required", "password_expired"])("登录 %s 触发 reset，重置成功后 signIn", async (code) => {
    const signIn = vi.fn();
    const resolveResp = () =>
      new Response(JSON.stringify({ data: { tenant_id: "t-uuid-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    // 序列:resolve → login(403) → 403 分支内再次 resolve → owner-reset
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(resolveResp())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Forbidden",
            status: 403,
            code,
            detail: "password reset required before login",
            instance: "/api/auth/login",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      )
      .mockResolvedValueOnce(resolveResp())
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
    expect(screen.getByText("账号：owner1")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const newPasswordInput = screen.getByTestId("new-password") as HTMLInputElement;
    const confirmPasswordInput = screen.getByTestId("confirm-new-password") as HTMLInputElement;
    fireEvent.change(newPasswordInput, { target: { value: "NewPass!234" } });
    fireEvent.change(confirmPasswordInput, { target: { value: "NewPass!234" } });
    fireEvent.click(screen.getByRole("button", { name: "设置新密码并登录" }));
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith("reset-token");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const secondCallBody = JSON.parse(fetchSpy.mock.calls[3]![1]!.body as string);
    expect(secondCallBody).toEqual({
      tenant_id: "t-uuid-1",
      account: "owner1",
      old_password: "bootstrap",
      new_password: "NewPass!234",
    });
  });
  it.each(["principal_inactive", "forbidden"])("403 %s 不进入密码重置", async (code) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { tenant_id: "t1" } }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "about:blank", title: "Denied", status: 403, code, detail: "not permitted" }), { status: 403, headers: { "Content-Type": "application/problem+json" } }));
    renderLogin();
    fireEvent.change(screen.getByLabelText("企业代码/名称"), { target: { value: "fixture" } });
    fireEvent.change(screen.getByLabelText("成员账号"), { target: { value: "member" } });
    fireEvent.change(screen.getByLabelText("登录密码"), { target: { value: "Fixture-Pass-1" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not permitted"));
    expect(screen.queryByTestId("owner-reset-form")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("Passkey登录完成真实浏览器DTO转换及同端三段API调用", async () => {
    const signIn = vi.fn();
    const buf = new Uint8Array([1]).buffer;
    vi.stubGlobal("navigator", { credentials: { get: vi.fn(async () => ({ id: "AQ", rawId: buf, type: "public-key", response: { clientDataJSON: buf, authenticatorData: buf, signature: buf, userHandle: null } })) } });
    const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ tenant_id: "t1" })).mockResolvedValueOnce(response({ challenge: "AQ", rpId: "localhost" })).mockResolvedValueOnce(response({ token: "issued" }));
    try {
      renderLogin({ signIn });
      fireEvent.change(screen.getByLabelText("企业代码/名称"), { target: { value: "fixture" } });
      fireEvent.change(screen.getByLabelText("成员账号"), { target: { value: "member" } });
      fireEvent.click(screen.getByRole("button", { name: "使用 Passkey 登录" }));
      await waitFor(() => expect(signIn).toHaveBeenCalledWith("issued"));
      expect(String(fetch.mock.calls[1]?.[0])).toContain("account=member");
      expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({ tenant_id: "t1", id: "AQ", response: { signature: "AQ" } });
    } finally { vi.unstubAllGlobals(); }
  });

  it("Passkey缺企业标识不发请求，OAuth仅列已配置提供方", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: ["github"] }), { headers: { "Content-Type": "application/json" } }));
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "使用 Passkey 登录" }));
    await screen.findByRole("alert");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "其他登录方式" }));
    await screen.findByRole("button", { name: "使用 github 登录" });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/auth/oauth/providers");
  });

});
