/**
 * 审计事件页测试：
 * - 列表渲染审计事件行
 * - 加载失败展示错误信息
 * - 空列表展示空态
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { AuditPage } from "../AuditPage";
import * as apiModule from "../useAuditApi";
import * as membersModule from "../../members/useMembersApi";
import * as expertsModule from "../../experts/useExpertsApi";
import type { AuditEvent } from "../types";

vi.mock("../../members/useMembersApi", () => ({ useMembersApi: vi.fn() }));
vi.mock("../../experts/useExpertsApi", () => ({ useExpertsApi: vi.fn() }));

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

function mockApi(overrides: Partial<apiModule.AuditApi> = {}) {
  vi.mocked(membersModule.useMembersApi).mockReturnValue({
    listMembers: vi.fn().mockResolvedValue([{ id: "m1", display_name: "张三" }]),
    createMember: vi.fn(), updateMember: vi.fn(), deleteMember: vi.fn(), listDepartments: vi.fn(),
  });
  vi.mocked(expertsModule.useExpertsApi).mockReturnValue({
    listEmployees: vi.fn().mockResolvedValue([{ employee_id: "e1", display_name: "专家A" }]),
    listTemplates: vi.fn(), listSolutions: vi.fn(), recruitExpert: vi.fn(), applySolution: vi.fn(),
    updateEmployee: vi.fn(), transitionEmployee: vi.fn(), getLifecycleOptions: vi.fn(), listSolutionInstances: vi.fn(),
  });
  const api: apiModule.AuditApi = {
    list: vi.fn().mockResolvedValue([
      { event_id: "e1", event_type: "member.created", actor_id: "u1", target_type: "member", target_id: "m1", detail: {}, created_at: "2026-06-30T10:00:00Z" },
    ]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useAuditApi").mockReturnValue(api);
  return api;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <AuditPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("AuditPage 审计事件", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("使用 Astryx 表格语义展示审计事件", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByRole("table", { name: "审计事件" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "事件类型" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("member.created")).toBeInTheDocument();
    expect(screen.getByText("成员：张三")).toBeInTheDocument();
    expect(screen.queryByText("m1")).not.toBeInTheDocument();
  });

  it("按事件类型筛选并翻页", async () => {
    const api = mockApi();
    renderPage();
    fireEvent.change(screen.getByLabelText("事件类型筛选"), {
      target: { value: "member.created" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenCalledWith({ event_type: "member.created", page: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenCalledWith({ event_type: "member.created", page: 2 }),
    );
  });

  it("第 1 页禁用上一页", async () => {
    mockApi();
    renderPage();
    await screen.findByRole("table", { name: "审计事件" });
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
  });

  it("筛选会从第 2 页重置到第 1 页", async () => {
    const api = mockApi();
    renderPage();
    await screen.findByRole("table", { name: "审计事件" });

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ event_type: undefined, page: 2 }),
    );

    fireEvent.change(screen.getByLabelText("事件类型筛选"), {
      target: { value: "member.deleted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ event_type: "member.deleted", page: 1 }),
    );
  });

  it("忽略晚到的旧请求成功结果", async () => {
    const oldRequest = deferred<AuditEvent[]>();
    const newRequest = deferred<AuditEvent[]>();
    const api = mockApi({
      list: vi.fn().mockImplementation(({ event_type }: { event_type?: string }) =>
        event_type ? newRequest.promise : oldRequest.promise,
      ),
    });
    renderPage();
    await waitFor(() =>
      expect(api.list).toHaveBeenNthCalledWith(1, { event_type: undefined, page: 1 }),
    );

    fireEvent.change(screen.getByLabelText("事件类型筛选"), {
      target: { value: "member.deleted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ event_type: "member.deleted", page: 1 }),
    );

    newRequest.resolve([
      { event_id: "new", event_type: "member.deleted", actor_id: null, target_type: null, target_id: null, detail: {}, created_at: "2026-06-30T10:00:00Z" },
    ]);
    expect(await screen.findByText("member.deleted")).toBeInTheDocument();

    await act(async () => {
      oldRequest.resolve([
        { event_id: "old", event_type: "member.created", actor_id: null, target_type: null, target_id: null, detail: {}, created_at: "2026-06-30T10:00:00Z" },
      ]);
    });
    expect(screen.queryByText("member.created")).not.toBeInTheDocument();
    expect(screen.getByText("member.deleted")).toBeInTheDocument();
  });

  it("忽略晚到的旧请求错误并保持新请求加载态", async () => {
    const oldRequest = deferred<AuditEvent[]>();
    const newRequest = deferred<AuditEvent[]>();
    const api = mockApi({
      list: vi.fn().mockImplementation(({ event_type }: { event_type?: string }) =>
        event_type ? newRequest.promise : oldRequest.promise,
      ),
    });
    renderPage();
    await waitFor(() =>
      expect(api.list).toHaveBeenNthCalledWith(1, { event_type: undefined, page: 1 }),
    );

    fireEvent.change(screen.getByLabelText("事件类型筛选"), {
      target: { value: "member.deleted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith({ event_type: "member.deleted", page: 1 }),
    );

    await act(async () => {
      oldRequest.reject(new ApiError("旧请求失败", 503, "stale_request_failed"));
    });
    expect(screen.getByRole("status", { name: "审计事件加载中" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("旧请求失败")).not.toBeInTheDocument();
    expect(screen.queryByText("member.created")).not.toBeInTheDocument();

    await act(async () => {
      newRequest.resolve([
        { event_id: "new", event_type: "member.deleted", actor_id: null, target_type: null, target_id: null, detail: {}, created_at: "2026-06-30T10:00:00Z" },
      ]);
    });
    expect(screen.getByText("member.deleted")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "审计事件加载中" })).not.toBeInTheDocument();
  });

  it("加载失败展示错误信息", async () => {
    mockApi({ list: vi.fn().mockRejectedValue(new ApiError("服务不可用", 503, "service_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeInTheDocument());
  });

  it("空列表展示空态", async () => {
    mockApi({ list: vi.fn().mockResolvedValue([]) });
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无审计事件")).toBeInTheDocument());
  });
});
