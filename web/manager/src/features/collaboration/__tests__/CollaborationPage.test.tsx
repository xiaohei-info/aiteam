/**
 * 协作模板页测试：
 * - 渲染模板表单
 * - 保存后重新拉取（刷新验证）
 * - 加载失败展示错误
 * - 保存失败展示 actionError
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { CollaborationPage } from "../CollaborationPage";
import * as apiModule from "../useCollabApi";

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

const tmpl = { template_id: "default", name: "默认模板", routing_prompt: "route", handoff_prompt: "handoff", max_replies_per_message: 3, updated_at: "2026-06-30T10:00:00Z" };

function mockApi(overrides: Partial<apiModule.CollabApi> = {}) {
  const api: apiModule.CollabApi = {
    get: vi.fn().mockResolvedValue(tmpl),
    update: vi.fn().mockResolvedValue(tmpl),
    ...overrides,
  };
  vi.spyOn(apiModule, "useCollabApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <CollaborationPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("CollaborationPage 协作模板", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染模板表单", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("默认模板")).toBeInTheDocument());
  });

  it("加载失败展示错误信息", async () => {
    mockApi({ get: vi.fn().mockRejectedValue(new ApiError("服务不可用", 503, "service_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeInTheDocument());
  });

  it("保存后重新拉取列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("默认模板")).toBeInTheDocument());

    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    // 保存成功后应重新拉取
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); // initial + after save
  });

  it("保存失败展示 actionError", async () => {
    const api = mockApi({ update: vi.fn().mockRejectedValue(new ApiError("保存失败，请稍后重试", 500, "internal_error")) });
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("默认模板")).toBeInTheDocument());

    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.getByText("保存失败，请稍后重试")).toBeInTheDocument());
  });
});
