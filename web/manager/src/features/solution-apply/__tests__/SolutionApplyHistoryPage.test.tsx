import React from "react";
/**
 * SolutionApplyHistoryPage 测试：
 * - 渲染已落地方案实例 + 展开后渲染方案应用记录（状态 pill）
 * - 加载失败展示错误
 * - 空实例列表展示空态
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { SolutionApplyHistoryPage } from "../SolutionApplyHistoryPage";
import * as apiModule from "../useSolutionApplyApi";

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

const INSTANCE = {
  id: "si-1", solution_id: "sol-1", solution_version: "1", display_name: "方案 A", status: "applied",
  created_at: null,
};

function mockApi(overrides: Partial<apiModule.SolutionApplyApi> = {}) {
  const api: apiModule.SolutionApplyApi = {
    listSolutionInstances: vi.fn().mockResolvedValue([INSTANCE]),
    listApplyRecords: vi.fn().mockResolvedValue([
      {
        id: "ev-1", solution_id: "sol-1", solution_version: "1", applied_by: "u1", status: "applied",
        expert_instance_ids: ["emp-1"], detail: {}, created_at: "2026-06-30T10:00:00Z", updated_at: null,
      },
    ]),
    ...overrides,
  };
  vi.spyOn(apiModule, "useSolutionApplyApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <SolutionApplyHistoryPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("渲染已落地方案实例，并展开显示方案应用记录", async () => {
  mockApi();
  renderPage();
  await waitFor(() => expect(screen.getByTestId("instance-row")).toBeInTheDocument());
  expect(screen.getByText("方案 A")).toBeInTheDocument();
  fireEvent.click(screen.getByText("查看应用历史"));
  await waitFor(() => expect(screen.getByTestId("apply-record-row")).toBeInTheDocument());
  expect(screen.getByTestId("apply-record-status").textContent).toBe("已应用");
});

it("加载失败展示错误信息", async () => {
  mockApi({ listSolutionInstances: vi.fn().mockRejectedValue(new ApiError("服务不可用", 503, "service_unavailable")) });
  renderPage();
  await waitFor(() => expect(screen.getByText("服务不可用")).toBeInTheDocument());
});

it("空实例列表展示空态", async () => {
  mockApi({ listSolutionInstances: vi.fn().mockResolvedValue([]) });
  renderPage();
  await waitFor(() => expect(screen.getByText("暂无已落地方案")).toBeInTheDocument());
});
