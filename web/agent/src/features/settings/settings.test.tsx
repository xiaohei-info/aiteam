/**
 * 设置页测试（agent）：
 * - 未登录时账号 Tab 展示「不可用」。
 * - 登录后展示账号字段（用户ID/角色/Token过期时间）。
 * - 偏好 Tab 支持切换语言（同步到 i18n + localStorage）。
 * - 安全 Tab 退出登录按钮连接 useApp().logout。
 */

import { describe, expect, it, afterEach } from "vitest";
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

afterEach(() => {
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
});
