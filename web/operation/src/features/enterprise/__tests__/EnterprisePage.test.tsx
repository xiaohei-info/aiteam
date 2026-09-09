/**
 * 企业开通页测试（W-O.2）：
 * - 开通表单渲染与提交（路径 POST /api/operation/enterprises，字段 owner_phone）
 * - bootstrap_secret 一次性展示（owner_bootstrap_secret）
 * - 重置入口（路径 POST /enterprises/{id}/owner-bootstrap/reset）
 * - bootstrap_secret 不写 localStorage
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiClient, createI18n, sharedMessages } from "@aiteam/shared";
import { I18nContext } from "../../../i18n/context";
import { operationMessages } from "../../../i18n/messages";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { EnterprisePage } from "../EnterprisePage";

const providerApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  models: vi.fn(),
}));

vi.mock("../../providers/usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => providerApiMocks,
}));

function makeI18n() {
  const i18n = createI18n({ locale: "zh-CN", catalog: sharedMessages });
  i18n.extend("zh-CN", operationMessages["zh-CN"]!);
  return i18n;
}

const noopSession: SessionContextValue = {
  session: null,
  token: null,
  signIn: () => {},
  signOut: () => {},
  onUnauthorized: () => {},
};

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    post: vi.fn(),
    get: vi.fn(),
    listGet: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    request: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function renderEnterprisePage(client: ApiClient) {
  return render(
    <I18nContext.Provider value={makeI18n()}>
      <SessionContext.Provider value={noopSession}>
        <MemoryRouter>
          <EnterprisePage apiClient={client} />
        </MemoryRouter>
      </SessionContext.Provider>
    </I18nContext.Provider>,
  );
}

describe("EnterprisePage 企业开通", () => {
  beforeEach(() => {
    localStorage.clear();
    providerApiMocks.list.mockResolvedValue([]);
    providerApiMocks.models.mockResolvedValue([]);
  });
  afterEach(() => { localStorage.clear(); });

  it("渲染开通表单（企业名称 + 负责人手机号 + 提交按钮）", () => {
    renderEnterprisePage(mockClient());
    expect(screen.getByRole("heading", { level: 1, name: "企业开通" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "开通企业" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "重置负责人凭据" })).toBeInTheDocument();
    expect(screen.getByText("企业名称")).toBeInTheDocument();
    expect(screen.getByText("负责人手机号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开通" })).toBeInTheDocument();
  });

  it("加载已发布且已定价模型，并在开通时提交企业开放范围", async () => {
    providerApiMocks.list.mockResolvedValue([
      { provider_id: "p1", display_name: "测试网关", status: "published", version: 1 },
      { provider_id: "p2", display_name: "草稿网关", status: "draft", version: 1 },
    ]);
    providerApiMocks.models.mockResolvedValue([
      {
        model: { provider_id: "p1", model_id: "m1", display_name: "模型一", status: "published", version: 2 },
        rate: { pricing_status: "known" },
      },
      {
        model: { provider_id: "p1", model_id: "m2", display_name: "未定价模型", status: "published", version: 1 },
        rate: { pricing_status: "unknown" },
      },
    ]);
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001", tenant_id: "t_001", enterprise_name: "测试企业",
        owner_phone: "13800138000", owner_bootstrap_secret: "secret", must_reset: true,
      }),
    });
    renderEnterprisePage(client);

    await waitFor(() => expect(providerApiMocks.models).toHaveBeenCalledWith("p1"));
    fireEvent.change(screen.getByPlaceholderText("企业名称"), { target: { value: "测试企业" } });
    fireEvent.change(screen.getByPlaceholderText("负责人手机号"), { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      "/api/operation/enterprises",
      expect.objectContaining({ body: expect.objectContaining({
        allowed_model_refs: [{ provider_id: "p1", provider_version: 1, model_id: "m1", model_version: 2 }],
      }) }),
    ));
  });

  it("空字段提交显示校验提示", async () => {
    const client = mockClient();
    renderEnterprisePage(client);
    fireEvent.click(screen.getByRole("button", { name: "开通" }));
    await waitFor(() => {
      expect(screen.getByText("请输入企业名称")).toBeInTheDocument();
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("填写完整后提交调 POST /api/operation/enterprises", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001",
        tenant_id: "t_001",
        enterprise_name: "测试企业",
        owner_phone: "13800138000",
        owner_bootstrap_secret: "sec_test_abc123",
        must_reset: true,
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("负责人手机号"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(client.post).toHaveBeenCalledWith(
        "/api/operation/enterprises",
        expect.objectContaining({
          body: expect.objectContaining({
            enterprise_name: "测试企业",
            owner_phone: "13800138000",
          }),
        }),
      );
    });
  });

  it("provision 成功后展示 owner_bootstrap_secret 与复制按钮", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001",
        tenant_id: "t_001",
        enterprise_name: "测试企业",
        owner_phone: "13800138000",
        owner_bootstrap_secret: "sec_test_abc123",
        must_reset: true,
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("负责人手机号"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByTestId("secret-display")).toBeInTheDocument();
    });
    expect(screen.getByText("一次性 bootstrap 凭据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制凭据" })).toBeInTheDocument();
    expect(screen.queryByText("sec_test_abc123")).toBeNull();

    // 开通结果完整字段：tenant_id / owner_phone / enterprise_code / must_reset
    expect(screen.getByText("ent_001")).toBeInTheDocument();
    expect(screen.getByText("t_001")).toBeInTheDocument();
    expect(screen.getByText("13800138000")).toBeInTheDocument();
    expect(screen.getByText("是")).toBeInTheDocument();
  });

  it("展示重置凭据入口", () => {
    renderEnterprisePage(mockClient());
    expect(screen.getByRole("form", { name: "重置负责人凭据" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重置凭据" })[0]).toBeInTheDocument();
  });

  it("重置凭据调用 POST /enterprises/{id}/owner-bootstrap/reset", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001",
        tenant_id: "t_001",
        owner_phone: "13800138000",
        owner_bootstrap_secret: "sec_new_xyz789",
        must_reset: true,
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业 ID"), {
      target: { value: "ent_001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置凭据" }));

    expect(screen.getByRole("alertdialog", { name: "重置负责人凭据" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));

    await waitFor(() => {
      expect(client.post).toHaveBeenCalledWith(
        "/api/operation/enterprises/ent_001/owner-bootstrap/reset",
        {},
      );
    });
    await waitFor(() => {
      expect(screen.getByText("凭据已重置")).toBeInTheDocument();
    });

    // 重置结果字段：tenant_id / owner_phone / must_reset
    const displays = screen.getAllByTestId("secret-display");
    expect(displays.length).toBeGreaterThan(0);
    expect(screen.getAllByText("ent_001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("t_001").length).toBeGreaterThan(0);
    expect(screen.getAllByText("13800138000").length).toBeGreaterThan(0);
  });

  it("bootstrap_secret 不写入 localStorage", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001",
        tenant_id: "t_001",
        enterprise_name: "测试企业",
        owner_phone: "13800138000",
        owner_bootstrap_secret: "sec_test_abc123",
        must_reset: true,
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("负责人手机号"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByTestId("secret-display")).toBeInTheDocument();
    });

    const keys = Object.keys(localStorage);
    const hasSecret = keys.some(
      (k) => k.toLowerCase().includes("secret") || k.toLowerCase().includes("bootstrap"),
    );
    expect(hasSecret).toBe(false);
    for (const key of keys) {
      expect(localStorage.getItem(key)).not.toContain("sec_test_abc123");
    }
  });

  it("API 错误时展示错误提示", async () => {
    const client = mockClient({
      post: vi.fn().mockRejectedValue(new Error("网络错误")),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("负责人手机号"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("网络错误");
    });
    expect(screen.getByRole("textbox", { name: /企业名称/ })).toHaveValue("测试企业");
    expect(screen.getByRole("textbox", { name: /负责人手机号/ })).toHaveValue("13800138000");
  });

  it("一次性凭据可明确关闭，关闭后不再出现在 DOM", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        enterprise_id: "ent_001",
        tenant_id: "t_001",
        enterprise_name: "测试企业",
        owner_phone: "13800138000",
        owner_bootstrap_secret: "sec_test_abc123",
        must_reset: true,
      }),
    });
    renderEnterprisePage(client);
    fireEvent.change(screen.getByRole("textbox", { name: /企业名称/ }), { target: { value: "测试企业" } });
    fireEvent.change(screen.getByRole("textbox", { name: /负责人手机号/ }), { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    expect(await screen.findByRole("region", { name: "一次性 bootstrap 凭据" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭凭据" }));
    expect(screen.queryByRole("region", { name: "一次性 bootstrap 凭据" })).toBeNull();
  });
});
