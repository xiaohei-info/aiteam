import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { type AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { ProvidersPage } from "../ProvidersPage";
import { useProvidersApi } from "../useProvidersApi";

vi.mock("../useProvidersApi", () => ({ useProvidersApi: vi.fn() }));

import type { ProvidersApi } from "../useProvidersApi";
import type { ProviderCredential } from "../types";

function sessionValue(roles: string[]): SessionContextValue {
  const session = {
    principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles },
    claims: { user_id: "u1", tenant_id: "t1", roles, exp: Math.floor(Date.now() / 1000) + 3600 },
  } as AuthSession;
  return { session, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
}

const existing: ProviderCredential = {
  credential_id: "cred-1",
  provider_ref: "openai-main",
  display_name: "OpenAI",
  mode: "relay",
  endpoint: null,
  visibility: "tenant",
  allowed_member_ids: [],
  version: 1,
  supported_models: [{ model: "gpt-4o", display_name: "GPT-4o", enabled: true }],
};

function mockApi(overrides: Partial<ProvidersApi> = {}): ProvidersApi {
  const api: ProvidersApi = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (useProvidersApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <SessionContext.Provider value={sessionValue(roles)}>
      <MemoryRouter><ProvidersPage /></MemoryRouter>
    </SessionContext.Provider>,
  );
}

describe("ProvidersPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("空状态：无凭据时显示空提示", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据。")).toBeInTheDocument());
  });

  it("列表：展示已有 provider 凭据", async () => {
    mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Provider 凭据" })).toBeInTheDocument();
  });

  it("只读角色（member）不显示新增凭据入口与删除操作", async () => {
    mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    expect(screen.queryByText("新增凭据")).not.toBeInTheDocument();
    expect(screen.queryByText("删除")).not.toBeInTheDocument();
  });

  it("创建：填写 provider_ref/secret 提交，api.create 被调用", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    expect(screen.getByRole("dialog", { name: "新增凭据" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider_ref: "newapi-main", secret: "sk-..." }),
      ),
    );
  });

  it("创建：必填校验，缺 provider_ref 显示错误", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(screen.getByText("provider_ref 和 secret 为必填")).toBeInTheDocument());
    expect(api.create).not.toHaveBeenCalled();
  });

  it("能力目录：添加模型行并渲染输入控件", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据。")).toBeInTheDocument());
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByText("＋ 添加模型"));
    expect(screen.getByPlaceholderText("模型标识，如 gpt-4o")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("显示名（可选）")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("能力目录：提交时把 supported_models 传给 api.create", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByText("＋ 添加模型"));
    fireEvent.change(screen.getByPlaceholderText("模型标识，如 gpt-4o"), { target: { value: "gpt-4o" } });
    fireEvent.change(screen.getByPlaceholderText("显示名（可选）"), { target: { value: "GPT-4o" } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          supported_models: [{ model: "gpt-4o", display_name: "GPT-4o", enabled: true }],
        }),
      ),
    );
  });

  it("能力目录：提交时过滤掉空 model 行", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByText("＋ 添加模型")); // 空行，不填
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ supported_models: [] })),
    );
  });

  it("能力目录：移除模型行", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据。")).toBeInTheDocument());
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByText("＋ 添加模型"));
    expect(screen.getByPlaceholderText("模型标识，如 gpt-4o")).toBeInTheDocument();
    fireEvent.click(screen.getByText("移除"));
    expect(screen.queryByPlaceholderText("模型标识，如 gpt-4o")).not.toBeInTheDocument();
  });

  it("能力目录：切换启用 checkbox", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据。")).toBeInTheDocument());
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByText("＋ 添加模型"));
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("创建成功后表单收起并重置 models", async () => {
    mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByText("＋ 添加模型"));
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(screen.queryByText("创建")).not.toBeInTheDocument());
    expect(screen.queryByPlaceholderText("模型标识，如 gpt-4o")).not.toBeInTheDocument();
  });

  it("取消创建：关闭 Dialog 且不调用 create", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增凭据" })).not.toBeInTheDocument());
    expect(api.create).not.toHaveBeenCalled();
  });

  it("创建失败：显示错误并保留 Dialog", async () => {
    const api = mockApi({ create: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-..." } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("创建失败"));
    expect(screen.getByRole("dialog", { name: "新增凭据" })).toBeInTheDocument();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("加载失败：显示错误 Banner", async () => {
    mockApi({ list: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("加载失败"));
  });

  it("删除：点击删除调用 api.del 并刷新列表", async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("cred-1"));
  });
});
