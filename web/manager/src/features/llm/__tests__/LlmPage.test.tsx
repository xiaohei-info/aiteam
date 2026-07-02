/**
 * LLM 管理页测试（B01）：
 * - 渲染 Provider + Model 列表
 * - 加载失败展示错误
 * - 创建 Provider 后刷新列表
 * - 创建失败展示 actionError
 * - 编辑 Provider（name/base_url/is_active）后刷新列表
 * - 编辑校验失败展示 actionError
 * - 删除 Provider 并移除行
 * - 删除失败展示 actionError
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
import type { LlmProvider } from "../types";

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

const provider = {
  provider_id: "p1", name: "OpenAI", provider_key: "openai",
  base_url: null, is_active: true, model_count: 2, created_at: "2026-06-30T10:00:00Z",
};
const model = {
  model_id: "m1", provider_id: "p1", model_uid: "gpt-5",
  model_name: "GPT-5", context_window: 128000, input_price: null, output_price: null, is_active: true,
};

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
    mockApi({
      listProviders: vi.fn().mockRejectedValue(new ApiError("LLM 服务不可用", 503, "llm_unavailable")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("LLM 服务不可用")).toBeInTheDocument());
  });

  it("创建 Provider 后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("open-create"));
    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Anthropic" } });
    fireEvent.change(screen.getByTestId("field-key"), { target: { value: "anthropic" } });
    fireEvent.click(screen.getByTestId("submit-form"));

    await waitFor(() =>
      expect(api.createProvider).toHaveBeenCalledWith({ name: "Anthropic", provider_key: "anthropic" }),
    );
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2));
  });

  it("创建失败展示 actionError", async () => {
    mockApi({
      createProvider: vi.fn().mockRejectedValue(new ApiError("Provider 名称已存在", 409, "duplicate")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("open-create"));
    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "OpenAI" } });
    fireEvent.change(screen.getByTestId("field-key"), { target: { value: "dup" } });
    fireEvent.click(screen.getByTestId("submit-form"));

    await waitFor(() =>
      expect(screen.getByTestId("action-error")).toHaveTextContent("Provider 名称已存在"),
    );
  });

  it("编辑 Provider 名称/base_url/is_active 并刷新", async () => {
    const updated = { ...provider, name: "OpenAI v2", base_url: "https://api.example.com", is_active: false };
    const api = mockApi({ patchProvider: vi.fn().mockResolvedValue(updated) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("edit-p1"));
    expect(screen.getByTestId("edit-form")).toBeInTheDocument();
    // provider_key 在编辑态只读
    expect(screen.getByTestId("field-key")).toBeDisabled();

    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "OpenAI v2" } });
    fireEvent.change(screen.getByTestId("field-baseurl"), { target: { value: "https://api.example.com" } });
    fireEvent.click(screen.getByTestId("field-is-active"));
    fireEvent.click(screen.getByTestId("submit-form"));

    await waitFor(() =>
      expect(api.patchProvider).toHaveBeenCalledWith("p1", {
        name: "OpenAI v2",
        base_url: "https://api.example.com",
        is_active: false,
      }),
    );
    await waitFor(() => expect(api.listProviders).toHaveBeenCalledTimes(2));
  });

  it("编辑校验失败展示 actionError", async () => {
    const api = mockApi({
      patchProvider: vi.fn().mockRejectedValue(new ApiError("名称重复", 409, "conflict")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("edit-p1"));
    fireEvent.change(screen.getByTestId("field-name"), { target: { value: "DupName" } });
    fireEvent.click(screen.getByTestId("submit-form"));

    await waitFor(() =>
      expect(screen.getByTestId("action-error")).toHaveTextContent("名称重复"),
    );
    expect(api.patchProvider).toHaveBeenCalled();
  });

  it("删除 Provider 并移除行", async () => {
    const api = mockApi();
    // mount 时 1 次；删除触发 refresh 后的第 2 次起返回空 → 行消失
    vi.mocked(api.listProviders).mockResolvedValueOnce([provider]).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("delete-p1"));
    await waitFor(() => expect(api.deleteProvider).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByTestId("provider-row")).not.toBeInTheDocument());
  });

  it("删除失败展示 actionError", async () => {
    const api = mockApi({
      deleteProvider: vi.fn().mockRejectedValue(new ApiError("仍有模型引用，无法删除", 409, "in_use")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("provider-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("delete-p1"));

    await waitFor(() =>
      expect(screen.getByTestId("action-error")).toHaveTextContent("仍有模型引用，无法删除"),
    );
    expect(api.deleteProvider).toHaveBeenCalledWith("p1");
  });

  // ---- Model 新增/删除（B01 扩展）----
  it("新增模型后刷新列表", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("model-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("open-create-model"));
    fireEvent.change(screen.getByTestId("m-field-uid"), { target: { value: "claude-4" } });
    fireEvent.change(screen.getByTestId("m-field-name"), { target: { value: "Claude 4" } });
    fireEvent.change(screen.getByTestId("m-field-ctx"), { target: { value: "200000" } });
    fireEvent.click(screen.getByTestId("submit-model"));

    await waitFor(() =>
      expect(api.createModel).toHaveBeenCalledWith("p1", {
        model_uid: "claude-4",
        model_name: "Claude 4",
        context_window: 200000,
        input_price: undefined,
        output_price: undefined,
      }),
    );
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2));
  });

  it("新增模型包含 input/output price", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("model-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("open-create-model"));
    fireEvent.change(screen.getByTestId("m-field-uid"), { target: { value: "gpt-5-mini" } });
    fireEvent.change(screen.getByTestId("m-field-name"), { target: { value: "GPT-5 mini" } });
    fireEvent.change(screen.getByTestId("m-field-in-price"), { target: { value: "0.0005" } });
    fireEvent.change(screen.getByTestId("m-field-out-price"), { target: { value: "0.0015" } });
    fireEvent.click(screen.getByTestId("submit-model"));

    await waitFor(() =>
      expect(api.createModel).toHaveBeenCalledWith("p1", {
        model_uid: "gpt-5-mini",
        model_name: "GPT-5 mini",
        context_window: undefined,
        input_price: "0.0005",
        output_price: "0.0015",
      }),
    );
  });

  it("删除模型调用 deleteModel 并刷新", async () => {
    const api = mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("model-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("delete-model-m1"));
    await waitFor(() => expect(api.deleteModel).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(2));
  });

  it("删除模型失败展示 actionError", async () => {
    mockApi({
      deleteModel: vi.fn().mockRejectedValue(new ApiError("模型不存在", 404, "not_found")),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("model-row")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("delete-model-m1"));
    await waitFor(() => expect(screen.getByTestId("action-error")).toHaveTextContent("模型不存在"));
  });
});
