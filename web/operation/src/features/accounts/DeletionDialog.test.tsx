import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../auth/session";
import { DeletionDialog } from "./DeletionDialog";
import { EnterpriseActions } from "./EnterpriseActions";
import { deletedLabel, type EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function ent(overrides: Partial<EnterpriseAccount> = {}): EnterpriseAccount {
  return {
    org_id: "ent_1", enterprise_name: "测试企业", contact_name: "张三", contact_phone: "000",
    registered_at: "2026-01-15T00:00:00Z", total_recharged: "0", token_consumed: 0,
    status: "closed", monthly_active: false, ...overrides,
  };
}

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  return {
    deleteEnterprise: vi.fn().mockResolvedValue({}),
    restoreEnterprise: vi.fn().mockResolvedValue({}),
    purgeEnterprise: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as AccountsApi;
}

function session(role: string): SessionContextValue {
  return {
    session: { principal: { id: "u", roles: [role] }, claims: { user_id: "u", roles: [role] } } as never,
    token: "t", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
  };
}

function renderActions(role: string, enterprise: EnterpriseAccount, api = makeApi()) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={session(role)}>
        <MemoryRouter><EnterpriseActions api={api} enterprise={enterprise} onDone={() => {}} /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "操作" }), { key: "ArrowDown" });
}

describe("DeletionDialog", () => {
  it("删除必须输入完全一致的企业名称才可确认", async () => {
    const api = makeApi();
    const onDone = vi.fn();
    render(<DeletionDialog mode="delete" api={api} enterprise={ent()} onClose={() => {}} onDone={onDone} />);
    const confirm = screen.getByRole("button", { name: "确认删除" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "别的企业" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "测试企业" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteEnterprise).toHaveBeenCalledWith("ent_1", "测试企业"));
    expect(onDone).toHaveBeenCalled();
  });

  it("失败时留在弹窗并显示原因", async () => {
    const api = makeApi({ deleteEnterprise: vi.fn().mockRejectedValue(new Error("Manager 不可用")) });
    const onClose = vi.fn();
    render(<DeletionDialog mode="delete" api={api} enterprise={ent()} onClose={onClose} onDone={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "测试企业" } });
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByText("Manager 不可用")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("恢复无需输入名称", async () => {
    const api = makeApi();
    render(<DeletionDialog mode="restore" api={api} enterprise={ent({ status: "deleted" })} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(api.restoreEnterprise).toHaveBeenCalledWith("ent_1"));
  });

  it("清理不可撤销：必须输入完全一致的企业名称才可确认", async () => {
    const api = makeApi();
    render(<DeletionDialog mode="purge" api={api} enterprise={ent({ status: "deleted" })} onClose={() => {}} onDone={() => {}} />);
    const confirm = screen.getByRole("button", { name: "确认清理" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "别的企业" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "测试企业" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.purgeEnterprise).toHaveBeenCalledWith("ent_1"));
  });
});

describe("删除状态的展示与出口", () => {
  it("已删除状态显示剩余可恢复天数 / 可清理 / 已清理", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    expect(deletedLabel({ deleted_at: "2026-11-08T00:00:00Z" }, now)).toBe("已删除 · 25 天内可恢复");
    expect(deletedLabel({ deleted_at: "2026-10-01T00:00:00Z" }, now)).toBe("已删除 · 可清理");
    expect(deletedLabel({ deleted_at: "2026-10-01T00:00:00Z", purged_at: "2026-11-10T00:00:00Z" }, now)).toBe("已清理");
    expect(deletedLabel({}, now)).toBe("已删除");
  });

  it("恢复文案说明：只恢复数据，已注销企业不能重新启用", () => {
    render(<DeletionDialog mode="restore" api={makeApi()} enterprise={ent({ status: "deleted" })} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/不能重新启用/)).toBeInTheDocument();
    expect(screen.queryByText(/另行处理/)).not.toBeInTheDocument();
  });

  it("删除未完成时可以放弃删除，回到已注销", async () => {
    const api = makeApi();
    renderActions("system_admin", ent({ operation_status: "deleting" }), api);
    openMenu();
    fireEvent.click(await screen.findByText("放弃删除"));
    expect(await screen.findByRole("dialog", { name: "放弃删除" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认放弃" }));
    await waitFor(() => expect(api.restoreEnterprise).toHaveBeenCalledWith("ent_1"));
    expect(api.deleteEnterprise).not.toHaveBeenCalled();
  });

  it("没有可用操作时不显示空菜单", () => {
    const { unmount } = renderActions("system_operator", ent({ operation_status: "deleted", deleted_at: new Date().toISOString() }));
    expect(screen.queryByRole("button", { name: "操作" })).not.toBeInTheDocument();
    expect(screen.getByText("仅系统管理员可操作")).toBeInTheDocument();
    unmount();

    const r2 = renderActions("system_operator", ent({ operation_status: "deleting" }));
    expect(screen.queryByRole("button", { name: "操作" })).not.toBeInTheDocument();
    r2.unmount();

    renderActions("system_admin", ent({ operation_status: "deleted", deleted_at: "2026-01-01T00:00:00Z", purged_at: "2026-03-01T00:00:00Z" }));
    expect(screen.queryByRole("button", { name: "操作" })).not.toBeInTheDocument();
    expect(screen.queryByText("仅系统管理员可操作")).not.toBeInTheDocument();
  });
});

describe("EnterpriseActions 删除入口", () => {
  it("仅 system_admin 在已注销企业上看到「删除企业」", async () => {
    renderActions("system_admin", ent());
    openMenu();
    expect(await screen.findByText("删除企业")).toBeInTheDocument();
  });

  it("system_operator 看不到「删除企业」", async () => {
    renderActions("system_operator", ent());
    openMenu();
    await screen.findByText("充值");
    expect(screen.queryByText("删除企业")).not.toBeInTheDocument();
  });

  it("未注销的企业没有「删除企业」", async () => {
    renderActions("system_admin", ent({ status: "active", operation_status: "active" }));
    openMenu();
    await screen.findByText("充值");
    expect(screen.queryByText("删除企业")).not.toBeInTheDocument();
  });

  it("deleting 可继续删除；保留期内 deleted 可恢复；超期可清理", async () => {
    const { unmount } = renderActions("system_admin", ent({ operation_status: "deleting" }));
    openMenu();
    expect(await screen.findByText("继续删除（上次未完成）")).toBeInTheDocument();
    unmount();

    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const r2 = renderActions("system_admin", ent({ operation_status: "deleted", deleted_at: recent }));
    openMenu();
    expect(await screen.findByText("恢复企业")).toBeInTheDocument();
    expect(screen.queryByText("清理数据")).not.toBeInTheDocument();
    r2.unmount();

    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    renderActions("system_admin", ent({ operation_status: "deleted", deleted_at: old }));
    openMenu();
    expect(await screen.findByText("清理数据")).toBeInTheDocument();
    expect(screen.queryByText("恢复企业")).not.toBeInTheDocument();
  });
});
