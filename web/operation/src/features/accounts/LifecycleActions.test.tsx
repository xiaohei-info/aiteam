import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createI18n } from "@aiteam/shared";
import { I18nContext } from "../../i18n/context";
import { operationMessages } from "../../i18n/messages";
import { EnterpriseActions } from "./EnterpriseActions";
import type { EnterpriseAccount } from "./types";
import type { AccountsApi } from "./useAccountsApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: {} });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

function makeEnterprise(status = "active"): EnterpriseAccount {
  return {
    org_id: "ent_1",
    enterprise_name: "测试企业",
    contact_name: "张三",
    contact_phone: "13800000000",
    registered_at: "2026-01-15T00:00:00Z",
    total_recharged: "1000.00",
    token_consumed: 50_000,
    status,
    monthly_active: true,
  };
}

function makeApi(overrides: Partial<AccountsApi> = {}): AccountsApi {
  return {
    list: vi.fn(), getDetail: vi.fn(), exportAll: vi.fn(),
    doAction: vi.fn().mockResolvedValue({ ok: true }), getStats: vi.fn(),
    getLifecycleStatus: vi.fn(), changeLifecycle: vi.fn(), getQuota: vi.fn(),
    setQuota: vi.fn(), listAudits: vi.fn(), ...overrides,
  };
}

function renderActions(api = makeApi(), status = "active", onDone = vi.fn()) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <MemoryRouter>
        <EnterpriseActions api={api} enterprise={makeEnterprise(status)} onDone={onDone} />
      </MemoryRouter>
    </I18nContext.Provider>,
  );
}

async function openAction(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}

afterEach(() => vi.restoreAllMocks());

describe("LifecycleDialogs", () => {
  it("状态门控只暴露允许的生命周期动作", async () => {
    const { rerender } = renderActions(makeApi(), "active");
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    expect(await screen.findByRole("menuitem", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "注销" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "激活" })).not.toBeInTheDocument();

    rerender(
      <I18nContext.Provider value={makeI18n()}>
        <MemoryRouter><EnterpriseActions api={makeApi()} enterprise={makeEnterprise("closed")} onDone={vi.fn()} /></MemoryRouter>
      </I18nContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "操作" }));
    expect(screen.queryByRole("menuitem", { name: "暂停" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "注销" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "激活" })).not.toBeInTheDocument();
  });

  it("暂停由 AlertDialog 确认并保留 exact payload", async () => {
    const api = makeApi();
    renderActions(api);
    await openAction("暂停");
    expect(await screen.findByRole("dialog", { name: "暂停测试企业" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /原因/ }), { target: { value: "维护窗口" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("alertdialog", { name: "确认暂停测试企业" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认暂停" }));
    await waitFor(() => expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "suspend", reason: "维护窗口" }));
  });

  it("关闭要求原因，失败时 AlertDialog 与输入保持", async () => {
    const api = makeApi({ doAction: vi.fn().mockRejectedValue(new Error("关闭失败")) });
    renderActions(api);
    await openAction("注销");
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("必填字段未填写");
    expect(api.doAction).not.toHaveBeenCalled();

    const reason = screen.getByRole("textbox", { name: /原因/ });
    fireEvent.change(reason, { target: { value: "合同结束" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("alertdialog", { name: "确认注销测试企业" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认注销" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("关闭失败");
    expect(screen.getByRole("alertdialog", { name: "确认注销测试企业" })).toBeInTheDocument();
    expect(reason).toHaveValue("合同结束");
    expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "close", reason: "合同结束" });
  });

  it("暂停或封禁状态的激活动作也必须确认", async () => {
    const api = makeApi();
    renderActions(api, "suspended");
    await openAction("激活");
    expect(await screen.findByRole("alertdialog", { name: "激活测试企业" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认激活" }));
    await waitFor(() => expect(api.doAction).toHaveBeenCalledWith("ent_1", { action: "reactivate" }));
  });
});
