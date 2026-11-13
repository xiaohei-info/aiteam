import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { managerMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { AppShell } from "../AppShell";

const get = vi.fn();
vi.mock("../../api/client", () => ({ createManagerApiClient: () => ({ get }) }));

const policy = { min_length: 8, require_upper: true, require_lower: true, require_digit: true, require_symbol: true, max_age_days: 90 };
const me = (over: Record<string, unknown> = {}) => ({
  enterprise_name: "星河科技", enterprise_code: "acme", account_masked: "138****5678",
  roles: ["owner"], has_password: true, password_policy: policy, tenant_status: "active", ...over,
});

function renderShell(signOut = () => {}) {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  const value: SessionContextValue = { session, token: "tok", signIn: () => {}, signOut, onUnauthorized: () => {} };
  return render(
    <I18nContext.Provider value={i18n}>
      <SessionContext.Provider value={value}>
        <MemoryRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<p>页面内容</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("AppShell 企业状态提示", () => {
  // 必须带花括号：mockReset() 返回 mock 本身，直接返回会被 vitest 当成清理函数在用例结束后调用。
  beforeEach(() => { get.mockReset(); });

  it("企业正常时不显示任何提示", async () => {
    get.mockResolvedValue(me());
    renderShell();
    expect(await screen.findByText("星河科技")).toBeInTheDocument();
    expect(screen.getByText("页面内容")).toBeInTheDocument();
    expect(screen.queryByTestId("tenant-status-banner")).not.toBeInTheDocument();
  });

  it("企业暂停时页面顶部提示仅可查看，页面仍可浏览", async () => {
    get.mockResolvedValue(me({ tenant_status: "suspended" }));
    renderShell();
    expect(await screen.findByTestId("tenant-status-banner")).toHaveTextContent("企业已暂停，仅可查看");
    expect(screen.getByText("页面内容")).toBeInTheDocument();
  });

  it.each([
    ["tenant_banned", "企业已被封禁"],
    ["tenant_closed", "企业已注销"],
    ["tenant_deleted", "企业已删除"],
  ])("%s：整页说明原因并可退出登录，不再渲染页面", async (code, message) => {
    get.mockRejectedValue(new ApiError(message, 403, code));
    const signOut = vi.fn();
    renderShell(signOut);
    expect(await screen.findByRole("heading", { name: message })).toBeInTheDocument();
    expect(screen.queryByText("页面内容")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("读取概览失败（非企业状态原因）不影响页面", async () => {
    get.mockRejectedValue(new ApiError("服务暂不可用", 503, "service_unavailable"));
    renderShell();
    expect(await screen.findByText("页面内容")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();
  });
});
