/**
 * 企业开通页测试（W-O.2）：
 * - 开通表单渲染与提交
 * - bootstrap_secret 一次性展示 + 复制
 * - 重置入口
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

/** 构造一个模拟的 ApiClient，post 方法由测试控制 */
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
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("渲染开通表单（企业名称 + slug 输入框 + 提交按钮）", () => {
    const client = mockClient();
    renderEnterprisePage(client);
    expect(screen.getByText("企业名称")).toBeInTheDocument();
    expect(screen.getByText("企业标识（enterprise_slug）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开通" })).toBeInTheDocument();
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

  it("填写完整后提交调 POST /api/operation/enterprises/provision", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        bootstrap_secret: "sec_test_abc123",
        enterprise_id: "ent_001",
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("enterprise_slug"), {
      target: { value: "test-corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(client.post).toHaveBeenCalledWith(
        "/api/operation/enterprises/provision",
        {
          body: {
            enterprise_name: "测试企业",
            enterprise_slug: "test-corp",
          },
        },
      );
    });
  });

  it("provision 成功后展示 bootstrap_secret 与复制按钮", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        bootstrap_secret: "sec_test_abc123",
        enterprise_id: "ent_001",
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("enterprise_slug"), {
      target: { value: "test-corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByText("一次性 bootstrap 凭据")).toBeInTheDocument();
    });
    expect(screen.getByText(/仅显示一次/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制凭据" })).toBeInTheDocument();
    // bootstrap_secret 脱敏展示（不全文明文）
    expect(screen.queryByText("sec_test_abc123")).toBeNull();
    // 脱敏形式展示
    expect(screen.getByText(/sec_\*{4}c123/).textContent).toBeTruthy();
  });

  it("展示重置凭据入口", () => {
    const client = mockClient();
    renderEnterprisePage(client);
    expect(screen.getByText("重置负责人凭据")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "重置凭据" })[0],
    ).toBeInTheDocument();
  });

  it("重置凭据调用 POST /api/operation/enterprises/{id}/owner/bootstrap/reset", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        bootstrap_secret: "sec_new_xyz789",
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业 ID"), {
      target: { value: "ent_001" },
    });

    fireEvent.click(screen.getByRole("button", { name: "重置凭据" }));

    await waitFor(() => {
      expect(client.post).toHaveBeenCalledWith(
        "/api/operation/enterprises/ent_001/owner/bootstrap/reset",
        {},
      );
    });

    await waitFor(() => {
      expect(screen.getByText("凭据已重置")).toBeInTheDocument();
    });
  });

  it("bootstrap_secret 不写入 localStorage", async () => {
    const client = mockClient({
      post: vi.fn().mockResolvedValue({
        bootstrap_secret: "sec_test_abc123",
        enterprise_id: "ent_001",
      }),
    });
    renderEnterprisePage(client);

    fireEvent.change(screen.getByPlaceholderText("企业名称"), {
      target: { value: "测试企业" },
    });
    fireEvent.change(screen.getByPlaceholderText("enterprise_slug"), {
      target: { value: "test-corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByText("一次性 bootstrap 凭据")).toBeInTheDocument();
    });

    const keys = Object.keys(localStorage);
    const hasSecret = keys.some(
      (k) =>
        k.toLowerCase().includes("secret") ||
        k.toLowerCase().includes("bootstrap"),
    );
    expect(hasSecret).toBe(false);

    for (const key of keys) {
      const val = localStorage.getItem(key);
      expect(val).not.toContain("sec_test_abc123");
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
    fireEvent.change(screen.getByPlaceholderText("enterprise_slug"), {
      target: { value: "test-corp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开通" }));

    await waitFor(() => {
      expect(screen.getByText("操作失败，请重试")).toBeInTheDocument();
    });
  });
});
