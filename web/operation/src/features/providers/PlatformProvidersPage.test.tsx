import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformProvidersPage } from "./PlatformProvidersPage";

const providerApi = vi.hoisted(() => ({
  list: vi.fn(),
  models: vi.fn(),
  syncPublicPrices: vi.fn(),
  publishPricedModels: vi.fn(),
  publishModel: vi.fn(),
  setRate: vi.fn(),
}));

vi.mock("./usePlatformProvidersApi", () => ({
  usePlatformProvidersApi: () => providerApi,
}));

describe("PlatformProvidersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerApi.list.mockReturnValue(new Promise(() => {}));
    providerApi.models.mockResolvedValue([]);
  });

  it("不再提供新增服务入口，内部渠道由 NewAPI 管理", () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "新增大模型服务" })).not.toBeInTheDocument();
    expect(screen.getByText(/渠道配置在 NewAPI 管理面完成/)).toBeInTheDocument();
  });

  it("连接内置 NewAPI 后直接展示可用模型区域", async () => {
    providerApi.list.mockResolvedValue([{
      provider_id: "p1", provider_code: "newapi", display_name: "内部 NewAPI",
      relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
      status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
    }]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("NewAPI 暂无可用模型")).toBeInTheDocument());
  });

  it("在大模型服务页提供 NewAPI 网关超链接", async () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("href", "http://localhost:9300/");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "大模型服务" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开大模型网关" })).toHaveAttribute("title", expect.stringContaining("管理 Token"));
  });
});
