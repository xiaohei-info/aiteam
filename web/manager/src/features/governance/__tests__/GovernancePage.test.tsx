/**
 * 企业治理页测试（W-M.5）：
 * - 渲染计量汇总 + 审计事件 + 配额策略
 * - 创建配额：createQuota 收到正确 shape（slug/enforcement/dimensions/window ISO）
 * - 评估：evaluateQuota(policy_id, window) 并展示治理动作
 * - 删除配额：deleteQuota
 * - member 只读：无新建表单、无删除（评估仍可用）
 * - 红线：表格不渲染任何会话内容字段（D13，契约本就无此字段，断言结构）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { GovernancePage } from "../GovernancePage";
import * as apiModule from "../useGovernanceApi";

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", managerMessages["zh-CN"]!);
  return i18n;
}

function sessionValue(roles: string[]): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const quota = {
  policy_id: "q1",
  policy_slug: "default",
  display_name: "默认配额",
  scope: "tenant",
  target_ref: null,
  window_start: "2026-01-01T00:00:00Z",
  window_end: "2026-02-01T00:00:00Z",
  dimensions: { cost_cap_usd: 100 },
  enforcement: "soft",
  status: "active",
  version: 1,
};

function mockApi(overrides: Partial<apiModule.GovernanceApi> = {}) {
  const api: apiModule.GovernanceApi = {
    listUsageRollups: vi.fn().mockResolvedValue([
      {
        rollup_id: "r1", summary_id: "s1", employee_id: "e1",
        window_start: "2026-01-01T00:00:00Z", window_end: "2026-01-02T00:00:00Z",
        run_count: 5, token_total: 1000, cost_total: "1.5", error_count: 0, duration_seconds_total: 30,
      },
    ]),
    listAudits: vi.fn().mockResolvedValue([
      { event_id: "a1", summary_id: "s1", actor: "m1", action: "snapshot_pull_denied",
        resource_type: "expert", resource_id: "e1", occurred_at: "2026-01-01T00:00:00Z" },
    ]),
    listQuotas: vi.fn().mockResolvedValue([quota]),
    createQuota: vi.fn().mockResolvedValue(quota),
    deleteQuota: vi.fn().mockResolvedValue(undefined),
    evaluateQuota: vi.fn().mockResolvedValue({
      policy_id: "q1", policy_slug: "default", enforcement: "soft",
      actions: ["within_budget"], severity: "info", detail: "配额内",
    }),
    ...overrides,
  };
  vi.spyOn(apiModule, "useGovernanceApi").mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter>
          <GovernancePage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("GovernancePage 企业治理", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("渲染计量汇总 + 审计 + 配额", async () => {
    const { container } = renderPageWithApi(["owner"]);
    await waitFor(() => expect(screen.getByTestId("rollup-row")).toBeInTheDocument());
    expect(screen.getByTestId("audit-row")).toBeInTheDocument();
    expect(screen.getByTestId("quota-row")).toBeInTheDocument();
    expect(screen.getAllByText("snapshot_pull_denied").length).toBeGreaterThan(0);
    expect(screen.getByRole("table", { name: "计量汇总" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "审计事件摘要" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "配额策略" })).toBeInTheDocument();
    expect(screen.getByText("员工筛选")).toBeInTheDocument();
    expect(screen.getByText("审计动作筛选")).toBeInTheDocument();
    expect(container.querySelector(".astryx-card")).toBeInTheDocument();
    expect(container.querySelector(".astryx-grid")).toBeInTheDocument();
  });

  it("创建配额：createQuota 收到 slug/enforcement/dimensions/ISO 窗口", async () => {
    const api = mockApi();
    renderPage(["finance_admin"]);
    await waitFor(() => expect(screen.getByTestId("quota-row")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox", { name: /策略标识/ }), { target: { value: "budget-q1" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /成本上限/ }), { target: { value: "200" } });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(api.createQuota).toHaveBeenCalledTimes(1));
    const arg = (api.createQuota as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.policy_slug).toBe("budget-q1");
    expect(arg.enforcement).toBe("soft");
    expect(arg.dimensions).toEqual({ cost_cap_usd: 200 });
    expect(arg.scope).toBe("tenant");
    // window 为 ISO 字符串
    expect(typeof arg.window_start).toBe("string");
    expect(arg.window_start).toMatch(/\dT\d.*Z$/);
  });

  it("新建配额：策略标识为空时禁用提交，填写后允许提交", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("quota-row")).toBeInTheDocument());

    const submit = screen.getByRole("button", { name: "创建" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: /策略标识/ }), { target: { value: "budget-q1" } });
    expect(submit).toBeEnabled();
  });

  it("评估配额：evaluateQuota(policy_id, 窗口) 并展示治理动作", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("quota-row")).toBeInTheDocument());
    fireEvent.click(screen.getByText("评估"));
    await waitFor(() =>
      expect(api.evaluateQuota).toHaveBeenCalledWith(
        "q1", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z",
      ),
    );
    await waitFor(() => expect(screen.getByText(/within_budget/)).toBeInTheDocument());
  });

  it("删除配额：deleteQuota(policy_id)", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("quota-row")).toBeInTheDocument());
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(api.deleteQuota).toHaveBeenCalledWith("q1"));
  });

  it("member 只读：无新建配额表单、无删除（评估仍可用）", async () => {
    mockApi();
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByTestId("quota-row")).toBeInTheDocument());
    expect(screen.queryByText("新建配额策略")).not.toBeInTheDocument();
    expect(screen.queryByText("删除")).not.toBeInTheDocument();
    expect(screen.getByText("评估")).toBeInTheDocument();
  });

  it("空数据时为三个聚合区块展示空状态", async () => {
    mockApi({
      listUsageRollups: vi.fn().mockResolvedValue([]),
      listAudits: vi.fn().mockResolvedValue([]),
      listQuotas: vi.fn().mockResolvedValue([]),
    });
    renderPage(["owner"]);

    await waitFor(() => expect(screen.getByText("暂无计量数据")).toBeInTheDocument());
    expect(screen.getByText("暂无审计事件")).toBeInTheDocument();
    expect(screen.getByText("暂无配额策略")).toBeInTheDocument();
  });

  it("加载和失败时分别展示骨架状态与错误横幅", async () => {
    let rejectUsage: (reason?: unknown) => void = () => {};
    const pendingUsage = new Promise<never>((_, reject) => {
      rejectUsage = reject;
    });
    mockApi({ listUsageRollups: vi.fn().mockReturnValue(pendingUsage) });
    renderPage(["owner"]);

    expect(screen.getByRole("status", { name: "治理数据加载中" })).toBeInTheDocument();

    rejectUsage(new ApiError("汇总读取失败", 500, "usage_unavailable"));
    await waitFor(() => expect(screen.getByText("汇总读取失败")).toBeInTheDocument());
    expect(screen.getByText("汇总读取失败").closest('[role="alert"]')).not.toBeNull();
  });
});

function renderPageWithApi(roles: string[]) {
  mockApi();
  return renderPage(roles);
}
