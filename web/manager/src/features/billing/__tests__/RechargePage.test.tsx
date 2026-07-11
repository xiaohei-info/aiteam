/**
 * 充值页测试：
 * - 渲染充值记录列表
 * - 空状态提示
 * - 加载失败展示错误信息
 * - 输入金额并提交触发 createRecharge
 * - 提交后刷新列表
 * - 无效金额不触发提交
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { managerMessages } from "../../../i18n/messages";
import { RechargePage } from "../RechargePage";
import * as apiModule from "../useBillingApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
    claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const rechargeRecords = [
  { recharge_id: "r1", amount: "100.00", payment_method: "wechat", status: "success", order_no: "ORD001", token_credited: 400000, created_at: "2026-06-28T08:00:00Z" },
  { recharge_id: "r2", amount: "50.00", payment_method: "alipay", status: "pending", order_no: "ORD002", token_credited: 200000, created_at: "2026-06-29T09:30:00Z" },
];

function mockApi(overrides: Partial<apiModule.BillingApi> = {}) {
  const api: apiModule.BillingApi = {
    getOverview: vi.fn().mockResolvedValue(null),
    getRecords: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue(null),
    listRecharges: vi.fn().mockResolvedValue(rechargeRecords),
    createRecharge: vi.fn().mockResolvedValue(rechargeRecords[0]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useBillingApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <RechargePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("RechargePage 充值", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染充值记录列表", async () => {
    mockApi();
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText("ORD001")).toBeInTheDocument());
    expect(screen.getByText("ORD002")).toBeInTheDocument();
    expect(screen.getByText("¥100.00")).toBeInTheDocument();
    expect(screen.getByText("¥50.00")).toBeInTheDocument();
    expect(screen.getByText("400,000")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "充值记录" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "支付方式" })).toBeInTheDocument();
    expect(container.querySelector(".astryx-card")).toBeInTheDocument();
  });

  it("空状态：无充值记录时显示空提示", async () => {
    mockApi({ listRecharges: vi.fn().mockResolvedValue([]) });
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无充值记录")).toBeInTheDocument());
  });

  it("加载失败展示错误信息", async () => {
    mockApi({ listRecharges: vi.fn().mockRejectedValue(new ApiError("充值服务暂不可用", 503, "recharge_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("充值服务暂不可用"));
  });

  it("输入金额并提交触发 createRecharge", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("立即充值")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("请输入金额");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.click(screen.getByText("立即充值"));

    await waitFor(() => expect(api.createRecharge).toHaveBeenCalledWith(200, "wechat"));
  });

  it("提交后刷新充值列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("立即充值")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("请输入金额");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByText("立即充值"));

    await waitFor(() => expect(api.createRecharge).toHaveBeenCalledTimes(1));
    // listRecharges called on initial load + after submit
    await waitFor(() => expect(api.listRecharges).toHaveBeenCalledTimes(2));
  });

  it("空金额时按钮禁用", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("立即充值")).toBeInTheDocument());

    // Button disabled when amount is empty
    const button = screen.getByText("立即充值").closest("button")!;
    expect(button).toBeDisabled();
  });

  it("零或负金额不触发提交", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("立即充值")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("请输入金额");
    // Zero
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText("立即充值"));
    expect(api.createRecharge).not.toHaveBeenCalled();
    // Negative
    fireEvent.change(input, { target: { value: "-10" } });
    fireEvent.click(screen.getByText("立即充值"));
    expect(api.createRecharge).not.toHaveBeenCalled();
  });

  it("切换支付方式", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("微信支付")).toBeInTheDocument());

    fireEvent.click(screen.getByText("支付宝"));

    const input = screen.getByPlaceholderText("请输入金额");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByText("立即充值"));

    await waitFor(() => expect(api.createRecharge).toHaveBeenCalledWith(50, "alipay"));
  });

  it("提交失败展示错误信息", async () => {
    mockApi({ createRecharge: vi.fn().mockRejectedValue(new ApiError("充值创建失败", 500, "create_failed")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("立即充值")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("请输入金额");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByText("立即充值"));

    await waitFor(() => expect(screen.getByText("充值创建失败")).toBeInTheDocument());
  });
});
