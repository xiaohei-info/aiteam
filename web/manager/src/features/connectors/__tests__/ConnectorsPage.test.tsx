/**
 * 连接器页测试：
 * - 渲染预设列表
 * - 加载失败展示错误
 * - 测试连接成功展示结果
 * - 测试连接失败展示错误
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { ConnectorsPage } from "../ConnectorsPage";
import * as apiModule from "../useConnectorsApi";

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

const preset = { preset_id: "p1", name: "GitHub", type: "preset_oauth", icon: null, description: "GitHub 连接器" };

function mockApi(overrides: Partial<apiModule.ConnectorsApi> = {}) {
  const api: apiModule.ConnectorsApi = {
    getPresets: vi.fn().mockResolvedValue([preset]),
    getStatus: vi.fn().mockResolvedValue(null),
    test: vi.fn().mockResolvedValue({ connector_id: "p1", success: true, latency_ms: 42, message: "连接正常" }),
    setGrants: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.spyOn(apiModule, "useConnectorsApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <ConnectorsPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("ConnectorsPage 连接器", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染预设列表", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("GitHub")).toBeInTheDocument());
  });

  it("加载失败展示错误", async () => {
    mockApi({ getPresets: vi.fn().mockRejectedValue(new ApiError("连接器服务不可用", 503, "connector_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("连接器服务不可用")).toBeInTheDocument());
  });

  it("测试连接成功展示结果", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("GitHub")).toBeInTheDocument());
    fireEvent.click(screen.getByText("测试连接"));
    await waitFor(() => expect(screen.getByText(/✅ 连接正常 \(42ms\)/)).toBeInTheDocument());
  });

  it("测试连接失败展示错误", async () => {
    mockApi({ test: vi.fn().mockRejectedValue(new ApiError("连接超时", 504, "gateway_timeout")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("GitHub")).toBeInTheDocument());
    fireEvent.click(screen.getByText("测试连接"));
    await waitFor(() => expect(screen.getByText("连接超时")).toBeInTheDocument());
  });
});
