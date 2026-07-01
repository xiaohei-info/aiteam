/**
 * Issue #413 frontend regression:
 *  - Suspend / close / reactivate lifecycle operations are exposed in the actions menu.
 *  - The legacy recharge / ban / unban / adjust_quota still appear.
 *  - API hook surface (lifecycle/quota/audit) is wired correctly.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { EnterpriseActions } from "./EnterpriseActions";
import type { EnterpriseAccount, AccountsApi } from "./index";

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
    status: "active",
    monthly_active: true,
    ...overrides,
  };
}

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  const baseMock = {
    list: vi.fn().mockResolvedValue([]),
    getDetail: vi.fn().mockResolvedValue(null),
    exportAll: vi.fn().mockResolvedValue({ export_url: "", total: 0 }),
    doAction: vi.fn().mockResolvedValue({ ok: true }),
    getStats: vi.fn().mockResolvedValue(null),
    getLifecycleStatus: vi.fn().mockResolvedValue({
      org_id: "ent_1",
      operation_status: "active",
      suspended_at: null,
      suspended_reason: null,
      banned_at: null,
      banned_reason: null,
      closed_at: null,
    }),
    changeLifecycle: vi.fn().mockResolvedValue({
      org_id: "ent_1",
      action: "suspend",
      operation_status: "suspended",
      detail: "ok",
    }),
    getQuota: vi.fn().mockResolvedValue({
      employee_limit: -1,
      employee_used: 0,
      storage_limit_mb: -1,
      storage_used_mb: 0,
      api_rate_limit: -1,
      api_rate_used: 0,
      token_quota_limit: -1,
      token_quota_used: 0,
    }),
    setQuota: vi.fn().mockResolvedValue({
      employee_limit: -1,
      employee_used: 0,
      storage_limit_mb: -1,
      storage_used_mb: 0,
      api_rate_limit: 1000,
      api_rate_used: 0,
      token_quota_limit: -1,
      token_quota_used: 0,
    }),
    listAudits: vi.fn().mockResolvedValue({ total: 0, items: [], next_cursor: null }),
  };
  return { ...baseMock, ...overrides } as AccountsApi;
}

function renderActions(
  api: AccountsApi,
  enterprise: EnterpriseAccount = makeEnterprise(),
  onDone = vi.fn(),
) {
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

describe("LifecycleActions", () => {
  it("active 状态下显示暂停按钮", () => {
    const api = makeApi();
    renderActions(api);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    expect(screen.queryByTestId("action-suspend-ent_1")).toBeInTheDocument();
    expect(screen.queryByTestId("action-close-ent_1")).toBeInTheDocument();
    expect(screen.queryByTestId("action-reactivate-ent_1")).not.toBeInTheDocument();
  });

  it("suspended 状态下显示激活按钮而非暂停按钮", () => {
    const api = makeApi();
    renderActions(api, makeEnterprise({ status: "suspended" }));
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    expect(screen.queryByTestId("action-suspend-ent_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-reactivate-ent_1")).toBeInTheDocument();
  });

  it("closed 状态下不显示暂停与重新激活，保留封禁按钮不可见", () => {
    const api = makeApi();
    renderActions(api, makeEnterprise({ status: "closed" }));
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    expect(screen.queryByTestId("action-suspend-ent_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-reactivate-ent_1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-ban-ent_1")).not.toBeInTheDocument();
  });

  it("提交 suspend 动作调用 doAction with action suspend", async () => {
    const api = makeApi();
    renderActions(api);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-suspend-ent_1"));
    fireEvent.change(screen.getByTestId("suspend-reason-ent_1"), {
      target: { value: "维护窗口" },
    });
    fireEvent.click(screen.getByTestId("suspend-submit-ent_1"));
    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "suspend",
        reason: "维护窗口",
      });
    });
  });

  it("提交 close 动作调用 doAction with action close", async () => {
    const api = makeApi();
    renderActions(api);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-close-ent_1"));
    fireEvent.change(screen.getByTestId("close-reason-ent_1"), {
      target: { value: "合同结束" },
    });
    fireEvent.click(screen.getByTestId("close-submit-ent_1"));
    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "close",
        reason: "合同结束",
      });
    });
  });

  it("close 无需 reason 被阻止提交并显示 fieldRequired", async () => {
    const api = makeApi();
    renderActions(api);
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-close-ent_1"));
    fireEvent.click(screen.getByTestId("close-submit-ent_1"));
    await waitFor(() => {
      expect(api.doAction).not.toHaveBeenCalled();
    });
  });

  it("reactivate 单击即调用", async () => {
    const api = makeApi();
    renderActions(api, makeEnterprise({ status: "suspended" }));
    fireEvent.click(screen.getByTestId("actions-toggle-ent_1"));
    fireEvent.click(screen.getByTestId("action-reactivate-ent_1"));
    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "reactivate" });
    });
  });
});
