/**
 * LLM 管理页测试：
 * - 渲染 Provider + Model 列表
 * - 加载失败展示错误
 * - 创建 Provider 后刷新列表
 * - 创建失败展示 actionError
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { LlmPage } from "../LlmPage";
import * as apiModule from "../useLlmApi";

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

const provider = { provider_id: "p1", name: "OpenAI", provider_key: "openai", base_url: null, is_active: true, model_count: 2, created_at: "2026-06-30T10:00:00Z" };
const model = { model_id: "m1", provider_id: "p1", model_uid: "gpt-5", model_name: "GPT-5", context_window: 128000, input_price: null, output_price: null, is_active: true };

function mockApi(overrides: Partial<apiModule.LlmApi> = {}) {
  const api: apiModule.LlmApi = {
    listProviders: vi.fn().mockResolvedValue([provider]),
    createProvider: vi.fn().mockResolvedValue(provider),
    patchProvider: vi.fn().mockResolvedValue(null),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([model]),
    createModel: vi.fn().mockResolvedValue(null),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.spyOn(apiModule, "useLlmApi").mockReturnValue(api);
  return api;
}

function renderPage() {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue()}>
        <MemoryRouter>
          <LlmPage />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("LlmPage LLM管理", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染 Provider + Model 列表", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());
    expect(screen.getByTestId("model-row")).toBeInTheDocument();
    expect(screen.getByText("GPT-5")).toBeInTheDocument();
  });

  it("加载失败展示错误", async () => {
    mockApi({ listProviders: vi.fn().mockRejectedValue(new ApiError("LLM 服务不可用", 503, "llm_unavailable")) });
    renderPage();
    await waitFor(() => expect(screen.getByText("LLM 服务不可用")).toBeInTheDocument());
  });

  it("创建 Provider 后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("+ 新增 Provider"));
    fireEvent.change(screen.getByLabelText("Provider 名称"), { target: { value: "Anthropic" } });
    fireEvent.change(screen.getByLabelText("Provider Key"), { target: { value: "anthropic" } });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith({ name: "Anthropic", provider_key: "anthropic" }));
    // 创建后重新拉取
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2));
  });

  it("创建失败展示 actionError", async () => {
    mockApi({ createProvider: vi.fn().mockRejectedValue(new ApiError("Provider 名称已存在", 409, "duplicate")) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByText("+ 新增 Provider"));
    fireEvent.change(screen.getByLabelText("Provider 名称"), { target: { value: "OpenAI" } });
    fireEvent.change(screen.getByLabelText("Provider Key"), { target: { value: "dup" } });
    fireEvent.click(screen.getByText("创建"));

    await waitFor(() => expect(screen.getByText("Provider 名称已存在")).toBeInTheDocument());
  });
});
