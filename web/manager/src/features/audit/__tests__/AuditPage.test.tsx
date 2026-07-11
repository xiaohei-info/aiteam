/**
 * 审计事件页测试：
 * - 列表渲染审计事件行
 * - 加载失败展示错误信息
 * - 空列表展示空态
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { AuditPage } from "../AuditPage";
import * as apiModule from "../useAuditApi";

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
  const api: apiModule.AuditApi = {
    list: vi.fn().mockResolvedValue([
      { event_id: "e1", event_type: "member.created", actor_id: "u1", target_type: "member", target_id: "m1", detail: {}, created_at: "2026-06-30T10:00:00Z" },
    ]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useAuditApi").mockReturnValue(api);
  return api;
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
    expect(screen.getByText("member/m1")).toBeInTheDocument();
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
