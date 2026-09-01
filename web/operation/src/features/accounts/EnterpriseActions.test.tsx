import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { EnterpriseActions } from "./EnterpriseActions";
import type { EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function makeEnterprise(overrides: Partial<EnterpriseAccount> = {}): EnterpriseAccount {
  return {
    org_id: "ent_1",
    enterprise_name: "测试企业",
    contact_name: "张三",
    contact_phone: "13800000000",
    registered_at: "2026-01-15T00:00:00Z",
    total_recharged: "1000.00",
    token_consumed: 50_000,
    status: "active",
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
    getLifecycleStatus: vi.fn(),
    changeLifecycle: vi.fn(),
    getQuota: vi.fn(),
    setQuota: vi.fn(),
    listAudits: vi.fn(),
    ...overrides,
  };
}

const session: SessionContextValue = {
  session: null,
  token: "token",
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function renderActions(api = makeApi(), enterprise = makeEnterprise(), onDone = vi.fn()) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={session}>
        <MemoryRouter>
          <EnterpriseActions api={api} enterprise={enterprise} onDone={onDone} />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

function openMenu() {
  const trigger = screen.getByRole("button", { name: "操作" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return trigger;
}

afterEach(() => vi.restoreAllMocks());

describe("EnterpriseActions", () => {
  it("DropdownMenu 有 accessible name 且支持键盘打开与选择", async () => {
    renderActions();
    openMenu();
    const menu = await screen.findByRole("menu", { name: "操作" });
    expect(menu).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "充值" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "为测试企业充值" })).toBeInTheDocument();
  });

  it("充值 Dialog 精确保留 payload，成功关闭并返回焦点", async () => {
    const api = makeApi();
    const onDone = vi.fn();
    renderActions(api, makeEnterprise(), onDone);
    const trigger = screen.getByRole("button", { name: "操作" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "充值" }));

    fireEvent.change(await screen.findByRole("spinbutton", { name: /充值金额/ }), { target: { value: "100.5" } });
    fireEvent.click(screen.getByRole("combobox", { name: /支付方式/ }));
    fireEvent.click(screen.getByRole("option", { name: "支付宝" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(api.doAction).toHaveBeenCalledWith("ent_1", {
        action: "recharge",
        amount: "100.5",
        payment_method: "alipay",
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: "为测试企业充值" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("充值失败时 Dialog 保持打开且输入不丢失", async () => {
    const api = makeApi({ doAction: vi.fn().mockRejectedValue(new Error("充值失败")) });
    renderActions(api);
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "充值" }));
    const amount = await screen.findByRole("spinbutton", { name: /充值金额/ });
    fireEvent.change(amount, { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    expect(await screen.findByText("充值失败")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "为测试企业充值" })).toBeInTheDocument();
    expect(amount).toHaveValue(88);
  });

  it("打开企业模型开放配置 Dialog", async () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "配置可用模型" }));
    expect(await screen.findByRole("dialog", { name: "配置测试企业可用模型" })).toBeInTheDocument();
  });

  it("通知与配额使用命名 Dialog 并提交 exact payload", async () => {
    const api = makeApi();
    renderActions(api);

    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "发送通知" }));
    expect(await screen.findByRole("dialog", { name: "向测试企业发送通知" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /通知内容/ }), { target: { value: "请尽快续费" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.doAction).toHaveBeenLastCalledWith("ent_1", { action: "notify", message: "请尽快续费" }));

    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "调配额" }));
    expect(await screen.findByRole("dialog", { name: "调整测试企业配额" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("spinbutton", { name: /新配额/ }), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.doAction).toHaveBeenLastCalledWith("ent_1", { action: "adjust_quota", quota: "5000" }));
  });

  it("封禁和解封必须经命名 AlertDialog 确认", async () => {
    const api = makeApi();
    const { rerender } = renderActions(api);
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "封禁" }));
    expect(await screen.findByRole("alertdialog", { name: "封禁测试企业" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认封禁" }));
    await waitFor(() => expect(api.doAction).toHaveBeenLastCalledWith("ent_1", { action: "ban" }));

    rerender(
      <I18nContext.Provider value={makeI18n()}>
        <SessionContext.Provider value={session}>
          <MemoryRouter>
            <EnterpriseActions api={api} enterprise={makeEnterprise({ status: "banned" })} onDone={vi.fn()} />
          </MemoryRouter>
        </SessionContext.Provider>
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "解封" }));
    expect(await screen.findByRole("alertdialog", { name: "解封测试企业" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认解封" }));
    await waitFor(() => expect(api.doAction).toHaveBeenLastCalledWith("ent_1", { action: "unban" }));
  });
});
