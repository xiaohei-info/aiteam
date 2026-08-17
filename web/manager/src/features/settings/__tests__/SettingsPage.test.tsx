/**
 * 设置页测试：
 * - 渲染企业设置表单 + 邀请列表
 * - 加载失败展示错误
 * - 保存设置后刷新
 * - 发送邀请后刷新列表
 * - 撤销邀请后刷新列表
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { SettingsPage } from "../SettingsPage";
import * as apiModule from "../useSettingsApi";

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

const settings = { enterprise_name: "测试企业", logo_url: null, phone: null, contact_email: "contact@test.com", invite_required: true, member_approval: true, max_employees: 100, features: {}, updated_at: "2026-06-30T10:00:00Z" };
const invite = { invite_id: "i1", phone: "13800000000", display_name: "管理员A", status: "pending", created_at: "2026-06-30T10:00:00Z" };

function mockApi(overrides: Partial<apiModule.SettingsApi> = {}) {
  const api: apiModule.SettingsApi = {
    get: vi.fn().mockResolvedValue(settings),
    update: vi.fn().mockResolvedValue(settings),
    listInvites: vi.fn().mockResolvedValue([invite]),
    createInvite: vi.fn().mockResolvedValue(invite),
    deleteInvite: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.spyOn(apiModule, "useSettingsApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("SettingsPage 设置", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染企业设置表单 + 邀请列表", async () => {
    mockApi();
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("测试企业")).toBeInTheDocument());
    const row = screen.getByTestId("invite-row");
    expect(within(row).getByText(/13800000000/)).toBeInTheDocument();
    expect(within(row).getByText("pending")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "企业设置" })).toBeInTheDocument();
    expect(container.querySelector(".astryx-card")).toBeInTheDocument();
  });

  it("加载失败展示错误", async () => {
    mockApi({ get: vi.fn().mockRejectedValue(new ApiError("设置服务不可用", 503, "settings_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("设置服务不可用"));
  });

  it("保存设置后刷新", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("测试企业")).toBeInTheDocument());

    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it("发送邀请后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("invite-row")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("手机号"), { target: { value: "13900000000" } });
    fireEvent.click(screen.getByText("发送邀请"));
    await waitFor(() => expect(api.createInvite).toHaveBeenCalledWith("13900000000"));
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(2));
  });

  it("撤销邀请后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("invite-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("撤销"));
    await waitFor(() => expect(api.deleteInvite).toHaveBeenCalledWith("i1"));
    await waitFor(() => expect(api.listInvites).toHaveBeenCalledTimes(2));
  });

  it("保存失败展示 actionError", async () => {
    mockApi({ update: vi.fn().mockRejectedValue(new ApiError("企业名称已存在", 409, "duplicate")) });
    renderPage();
    await waitFor(() => expect(screen.getByDisplayValue("测试企业")).toBeInTheDocument());

    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(screen.getByText("企业名称已存在")).toBeInTheDocument());
  });
});
