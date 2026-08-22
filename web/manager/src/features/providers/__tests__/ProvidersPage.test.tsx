import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, createI18n, sharedMessages, type AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { I18nContext } from "../../../i18n/context";
import { managerMessages } from "../../../i18n/messages";
import { ProvidersPage } from "../ProvidersPage";
import { useProvidersApi } from "../useProvidersApi";

vi.mock("../useProvidersApi", () => ({ useProvidersApi: vi.fn() }));

import type { ProvidersApi } from "../useProvidersApi";
import type { ProviderCredential } from "../types";

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

const existing: ProviderCredential = {
  credential_id: "cred-1",
  provider_ref: "openai-main",
  display_name: "OpenAI",
  endpoint: "https://api.openai.example/v1",
  api_protocol: "openai-completions",
  visibility: "tenant",
  allowed_member_ids: [],
  version: 1,
  model_catalog_source: "manual",
  supported_models: [{ model: "gpt-4o", display_name: "GPT-4o", enabled: true }],
};

function mockApi(overrides: Partial<ProvidersApi> = {}): ProvidersApi {
  const api: ProvidersApi = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (useProvidersApi as unknown as ReturnType<typeof vi.fn>).mockReturnValue(api);
  return api;
}

function renderPage(roles: string[]) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={sessionValue(roles)}>
        <MemoryRouter><ProvidersPage /></MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("ProvidersPage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    document.querySelectorAll("[data-astryx-live-region]").forEach((node) => node.remove());
    vi.restoreAllMocks();
  });

  it("空状态：无凭据时显示空提示", async () => {
    mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据")).toBeInTheDocument());
    expect(screen.getByTestId("providers-empty")).toBeInTheDocument();
  });

  it("列表：展示已有 provider 凭据和版本，不展示 secret", async () => {
    mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Provider 凭据" })).toBeInTheDocument();
    expect(screen.queryByText("sk-old-secret")).not.toBeInTheDocument();
  });

  it("只读角色（member）不显示新增、编辑和删除操作", async () => {
    mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["member"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    expect(screen.getByText(/当前账号仅可查看/)).toBeInTheDocument();
    expect(screen.queryByText("新增凭据")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-edit-cred-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-delete-cred-1")).not.toBeInTheDocument();
  });

  it("创建：填写 provider_ref/secret 提交，api.create 被调用", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    expect(screen.getByRole("dialog", { name: "新增凭据" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider_ref: "newapi-main", secret: "sk-new" }),
      ),
    );
  });

  it("创建：必填校验，缺 provider_ref 显示错误", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(screen.getByText("Provider Ref 为必填")).toBeInTheDocument());
    expect(api.create).not.toHaveBeenCalled();
  });

  it("能力目录：添加模型行并提交 supported_models", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("暂无 Provider 凭据")).toBeInTheDocument());
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByText("＋ 添加模型"));
    fireEvent.change(screen.getByPlaceholderText("模型标识，如 gpt-4o"), { target: { value: "gpt-4o" } });
    fireEvent.change(screen.getByPlaceholderText("显示名（可选）"), { target: { value: "GPT-4o" } });
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      supported_models: [{ model: "gpt-4o", display_name: "GPT-4o", enabled: true }],
    })));
  });

  it("能力目录：空 model 行不会进入 PUT/POST payload", async () => {
    const api = mockApi();
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.click(screen.getByText("＋ 添加模型"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByText("创建"));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ supported_models: [] })));
  });

  it("编辑/轮换：PUT 携带新 secret、非敏感字段和模型目录，成功后刷新并显示版本变化", async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([existing]),
      update: vi.fn().mockResolvedValue({ ...existing, display_name: "OpenAI 新", version: 2 }),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-edit-cred-1"));
    expect(screen.getByRole("dialog", { name: "编辑 / 轮换凭据" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/显示名称（可选）/), { target: { value: "OpenAI 新" } });
    fireEvent.change(screen.getByLabelText(/Base URL（可选）/), { target: { value: "https://relay.example/v1" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-rotated" } });
    fireEvent.click(screen.getByText("保存并轮换"));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith("cred-1", {
      secret: "sk-rotated",
      display_name: "OpenAI 新",
      endpoint: "https://relay.example/v1",
      api_protocol: "openai-completions",
      visibility: "tenant",
      allowed_member_ids: [],
      supported_models: [{ model: "gpt-4o", display_name: "GPT-4o", enabled: true }],
      model_catalog_source: "manual",
    }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("providers-notice")).toHaveTextContent("版本 v1 → v2");
    expect(screen.queryByText("sk-rotated")).not.toBeInTheDocument();
  });

  it("编辑：缺少新 secret 时不提交，明确说明当前 PUT 要求 rotation", async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-edit-cred-1"));
    fireEvent.click(screen.getByText("保存并轮换"));
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getByText(/每次 PUT 都要求输入新的 Secret/)).toBeInTheDocument();
  });

  it("关闭编辑后清理 secret；重新打开时输入为空且旧 secret 不回显", async () => {
    const api = mockApi({ list: vi.fn().mockResolvedValue([existing]) });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-edit-cred-1"));
    const secret = screen.getByTestId("provider-secret-input") as HTMLInputElement;
    fireEvent.change(secret, { target: { value: "sk-close-only" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "编辑 / 轮换凭据" })).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑 / 轮换凭据" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-edit-cred-1"));
    expect((screen.getByTestId("provider-secret-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("sk-close-only")).not.toBeInTheDocument();
  });

  it("删除：先打开 AlertDialog，取消不调用；确认后调用并刷新", async () => {
    const api = mockApi({
      list: vi.fn().mockResolvedValueOnce([existing]).mockResolvedValueOnce([]),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-delete-cred-1"));
    const dialog = screen.getByRole("alertdialog", { name: "删除 Provider 凭据" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("provider-delete-cred-1"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("cred-1"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("删除冲突：展示有界 problem detail 并保留确认框，不刷新列表", async () => {
    const detail = "provider is referenced by an employee ".repeat(30);
    const api = mockApi({
      list: vi.fn().mockResolvedValue([existing]),
      del: vi.fn().mockRejectedValue(new ApiError(detail, 409, "conflict")),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-delete-cred-1"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("cred-1"));
    const actionError = await screen.findByTestId("providers-action-error");
    expect(actionError).toHaveTextContent("Provider 凭据操作存在冲突");
    expect(actionError.textContent).toContain(detail.slice(0, 220).trim());
    expect(actionError.textContent).not.toContain(detail.slice(240));
    expect(screen.getByRole("alertdialog", { name: "删除 Provider 凭据" })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "forbidden", "当前账号没有执行此 Provider 操作的权限"],
    [503, "manager_unavailable", "Provider 服务暂时不可用"],
    [0, "network_error", "无法连接 Manager 服务"],
  ])("删除失败 %s：展示受控错误且不抛出未捕获 Promise", async (status, code, message) => {
    const api = mockApi({
      list: vi.fn().mockResolvedValue([existing]),
      del: vi.fn().mockRejectedValue(status === 0 ? ApiError.network("offline") : new ApiError("detail", status, code)),
    });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByText("openai-main")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("provider-delete-cred-1"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.getByTestId("providers-action-error")).toHaveTextContent(message));
    expect(screen.getByRole("alertdialog", { name: "删除 Provider 凭据" })).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("加载失败：显示错误 Banner 并提供可访问重试", async () => {
    const list = vi.fn().mockRejectedValueOnce(ApiError.network("boom")).mockResolvedValueOnce([]);
    const api = mockApi({ list });
    renderPage(["owner"]);
    await waitFor(() => expect(screen.getByTestId("providers-error")).toHaveTextContent("无法连接 Manager 服务"));
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByTestId("providers-empty")).toBeInTheDocument());
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("创建失败：显示错误并保留 Dialog", async () => {
    const api = mockApi({ create: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPage(["owner"]);
    fireEvent.click(screen.getByText("新增凭据"));
    fireEvent.change(screen.getByLabelText(/Provider Ref/), { target: { value: "newapi-main" } });
    fireEvent.change(screen.getByLabelText(/Secret（明文，仅本次）/), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Provider 凭据创建失败"));
    expect(screen.getByRole("dialog", { name: "新增凭据" })).toBeInTheDocument();
    expect(api.create).toHaveBeenCalledTimes(1);
  });
});
