/**
 * S01 企业操作 UI 测试。
 *
 * 覆盖：菜单开关、各动作子面板（充值/通知/配额/封禁/解封）渲染、
 * 提交调 api.doAction、成功后回调 onDone、校验失败提示、接口错误提示。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { EnterpriseActions } from "./EnterpriseActions";
import type { EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

// ---- helpers ----

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const noopSession: SessionContextValue = {
  session: {
    principal: { id: "u1", display_name: "管理员", status: "active", roles: ["system_admin"] },
    claims: { user_id: "u1", roles: ["system_admin"], exp: Math.floor(Date.now() / 1000) + 3600 },
  },
  token: "test-token",
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function makeEnterprise(overrides: Record<string, unknown> = {}): EnterpriseAccount {
  return {
    org_id: "ent_1",
    enterprise_name: "测试企业",
    contact_name: "张三",
    contact_phone: "13800000000",
    registered_at: "2026-01-15T00:00:00Z",
    total_recharged: "1000.00",
    token_consumed: 50000,
    status: "normal",
    monthly_active: true,
    ...overrides,
  };
}

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  return {
    list: vi.fn(),
    getDetail: vi.fn(),
    exportAll: vi.fn(),
    doAction: vi.fn().mockResolvedValue({ ok: true }),
    getStats: vi.fn(),
    ...overrides,
  };
}

function renderActions(api: AccountsApi, enterprise: EnterpriseAccount, onDone = vi.fn()) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={noopSession}>
        <MemoryRouter>
          <EnterpriseActions api={api} enterprise={enterprise} onDone={onDone} />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EnterpriseActions", () => {
  it("默认渲染操作按钮", () => {
    renderActions(makeApi(), makeEnterprise());
    expect(screen.getByTestId("actions-toggle-ent_1")).toBeInTheDocument();
  });

  it("点击操作按钮打开菜单，显示 4 个动作入口", async () => {
    renderActions(makeApi(), makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    await waitFor(() => {
      expect(screen.getByTestId("actions-menu-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("action-recharge-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("action-notify-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("action-ban-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("action-quota-ent_1")).toBeInTheDocument();
    });
  });

  it("封禁状态的企业显示「解封」而非「封禁」", async () => {
    renderActions(makeApi(), makeEnterprise({ status: "banned" }));
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    await waitFor(() => {
      expect(screen.getByTestId("action-unban-ent_1")).toBeInTheDocument();
      expect(screen.queryByTestId("action-ban-ent_1")).not.toBeInTheDocument();
    });
  });

  it("选择「充值」进入充值表单，金额+支付方式齐全", async () => {
    renderActions(makeApi(), makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-recharge-ent_1"));
    await waitFor(() => {
      expect(screen.getByTestId("recharge-amount-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("recharge-payment-ent_1")).toBeInTheDocument();
      expect(screen.getByTestId("recharge-submit-ent_1")).toBeInTheDocument();
    });
  });

  it("提交空金额时显示必填提示，不发 API", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-recharge-ent_1"));
    fireEvent.click(await screen.findByTestId("recharge-submit-ent_1"));
    await waitFor(() => {
      expect(api.doAction).not.toHaveBeenCalled();
      expect(screen.getByText("必填字段未填写")).toBeInTheDocument();
    });
  });

  it("充值提交调 doAction 并触发 onDone", async () => {
    const api = makeApi();
    const onDone = vi.fn();
    renderActions(api, makeEnterprise(), onDone);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-recharge-ent_1"));

    fireEvent.change(await screen.findByTestId("recharge-amount-ent_1"), {
      target: { value: "100.50" },
    });
    fireEvent.change(screen.getByTestId("recharge-payment-ent_1"), {
      target: { value: "alipay" },
    });
    fireEvent.click(screen.getByTestId("recharge-submit-ent_1"));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "recharge",
        amount: "100.50",
        payment_method: "alipay",
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("发送通知提交调 doAction", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-notify-ent_1"));

    fireEvent.change(await screen.findByTestId("notify-message-ent_1"), {
      target: { value: "请尽快续费" },
    });
    fireEvent.click(screen.getByTestId("notify-submit-ent_1"));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "notify",
        message: "请尽快续费",
      });
    });
  });

  it("调配额提交调 doAction", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-quota-ent_1"));

    fireEvent.change(await screen.findByTestId("quota-value-ent_1"), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByTestId("quota-submit-ent_1"));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "adjust_quota",
        quota: "5000",
      });
    });
  });

  it("封禁确认调 doAction", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise());
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-ban-ent_1"));
    fireEvent.click(await screen.findByTestId("ban-confirm-ent_1"));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "ban" });
    });
  });

  it("解封确认调 doAction", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise({ status: "banned" }));
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-unban-ent_1"));
    fireEvent.click(await screen.findByTestId("unban-confirm-ent_1"));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "unban" });
    });
  });

  it("doAction 失败时显示错误，不触发 onDone", async () => {
    const api = makeApi({ doAction: vi.fn().mockRejectedValue(new Error("服务内部错误")) });
    const onDone = vi.fn();
    renderActions(api, makeEnterprise(), onDone);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-ban-ent_1"));
    fireEvent.click(await screen.findByTestId("ban-confirm-ent_1"));

    await waitFor(() => {
      expect(screen.getByText("服务内部错误")).toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();
    });
  });
});
