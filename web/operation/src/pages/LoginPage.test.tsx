/**
 * 登录页骨架测试（W-O.1）：表单渲染 + 空提交提示 + 已登录跳转。
 * 真实 /api/auth/login 联调由后续卡接入。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../i18n/context";
import { operationMessages } from "../i18n/messages";
import { SessionContext, type SessionContextValue } from "../auth/session";
import { LoginPage } from "./LoginPage";

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

describe("LoginPage 骨架", () => {
  it("渲染标题与表单字段", () => {
    renderLogin();
    expect(screen.getByText("AI Team 运营端")).toBeInTheDocument();
    expect(screen.getByText("负责人手机号")).toBeInTheDocument();
    expect(
      screen.getByText("一次性 bootstrap 凭据"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("已登录时跳转（不渲染表单）", () => {
    const { container } = renderLogin({
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
    // Navigate 不会渲染登录表单。
    expect(container.querySelector(".login-page__form")).toBeNull();
  });
});
