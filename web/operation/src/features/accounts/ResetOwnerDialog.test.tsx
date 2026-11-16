import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { EnterpriseActions } from "./EnterpriseActions";
import type { EnterpriseAccount, OwnerResetResult } from "./types";
import type { AccountsApi } from "./useAccountsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const ENTERPRISE: EnterpriseAccount = {
  org_id: "ent_1", enterprise_name: "测试企业", contact_name: "张三", contact_phone: "13800000000",
  registered_at: "2026-01-15T00:00:00Z", total_recharged: "1000.00", token_consumed: 50_000, status: "active", monthly_active: true,
};
const RESULT: OwnerResetResult = {
  enterprise_id: "ent_1", tenant_id: "t_1", owner_phone: "13800000000", owner_bootstrap_secret: "Sec!Reset-1234abcd", must_reset: true,
};
const session: SessionContextValue = { session: null, token: "t", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };

function makeApi(reset: AccountsApi["resetOwnerBootstrap"]): AccountsApi {
  return {
    list: vi.fn(), getDetail: vi.fn(), exportAll: vi.fn(), doAction: vi.fn(), getStats: vi.fn(),
    getLifecycleStatus: vi.fn(), changeLifecycle: vi.fn(), getQuota: vi.fn(), setQuota: vi.fn(), listAudits: vi.fn(),
    resetOwnerBootstrap: reset,
    deleteEnterprise: vi.fn(), restoreEnterprise: vi.fn(), purgeEnterprise: vi.fn(),
  };
}

function renderActions(api: AccountsApi, enterprise = ENTERPRISE) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={session}>
        <MemoryRouter><EnterpriseActions api={api} enterprise={enterprise} onDone={vi.fn()} /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

async function openReset() {
  fireEvent.click(screen.getByRole("button", { name: "操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "重置管理员密码" }));
}

afterEach(() => vi.restoreAllMocks());

describe("重置管理员密码", () => {
  it("行菜单里有入口，确认文案说明影响范围，取消不发请求", async () => {
    const reset = vi.fn();
    renderActions(makeApi(reset));
    await openReset();
    expect(await screen.findByText(/通行密钥等二次验证会被清除/)).toBeInTheDocument();
    expect(screen.getByText(/网页和桌面端都需要重新登录/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText(/通行密钥等二次验证会被清除/)).toBeNull());
    expect(reset).not.toHaveBeenCalled();
  });

  it("确认后带当前企业和幂等键调用，一次性展示新凭据，关闭后不可再看", async () => {
    const reset = vi.fn().mockResolvedValue(RESULT);
    renderActions(makeApi(reset));
    await openReset();
    fireEvent.click(await screen.findByRole("button", { name: "确认重置" }));
    expect(await screen.findByTestId("secret-display")).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith("ent_1", expect.stringMatching(/^owner-bootstrap-reset:/));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.queryByTestId("secret-display")).toBeNull());
  });

  it("失败时显示原因并允许重试，重试沿用同一个幂等键", async () => {
    const reset = vi.fn().mockRejectedValueOnce(new Error("网络错误")).mockResolvedValueOnce(RESULT);
    renderActions(makeApi(reset));
    await openReset();
    fireEvent.click(await screen.findByRole("button", { name: "确认重置" }));
    expect(await screen.findByText("网络错误")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    expect(await screen.findByTestId("secret-display")).toBeInTheDocument();
    expect(reset.mock.calls[0]![1]).toBe(reset.mock.calls[1]![1]);
  });

  it("已注销的企业菜单里没有重置入口", async () => {
    renderActions(makeApi(vi.fn()), { ...ENTERPRISE, status: "closed" });
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    await screen.findByRole("menuitem", { name: "充值" });
    expect(screen.queryByRole("menuitem", { name: "重置管理员密码" })).toBeNull();
  });
});
