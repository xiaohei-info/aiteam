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

  it("只展示 LLM 网关，不提供新增服务入口", () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "新增大模型服务" })).not.toBeInTheDocument();
    expect(screen.getByText(/统一通过 LLM 网关/)).toBeInTheDocument();
    expect(screen.queryByText(/NewAPI/i)).not.toBeInTheDocument();
  });

  it("连接 LLM 网关后直接展示可用模型区域", async () => {
    providerApi.list.mockResolvedValue([{
      provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关",
      relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
      status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
    }]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("LLM 网关暂无可用模型")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "发布全部有价格模型" })).not.toBeInTheDocument();
    expect(screen.getByText(/新模型会自动补齐公开价格并发布/)).toBeInTheDocument();
  });

  it("有价模型只保留价格维护入口，发布由后台自动完成", async () => {
    providerApi.list.mockResolvedValue([{
      provider_id: "p1", provider_code: "newapi", display_name: "LLM 网关",
      relay_base_url: "http://127.0.0.1:9300/v1", api_protocol: "openai-completions",
      status: "published", version: 1, updated_at: "2026-01-01T00:00:00Z",
    }]);
    providerApi.models.mockResolvedValue([{
      model: { provider_id: "p1", model_id: "minimax-m3", display_name: "MiniMax M3", capabilities: {}, status: "published", source: "discovery", version: 1, updated_at: "2026-01-01T00:00:00Z" },
      rate: { rate_id: "r1", provider_id: "p1", model_id: "minimax-m3", pricing_version: 1, pricing_status: "known", billing_mode: "token", input_usd_per_million: "0.3", output_usd_per_million: "1.2", cache_read_usd_per_million: null, cache_write_usd_per_million: null, request_usd: null, currency: "USD", source: "public_reference", effective_from: "2026-01-01T00:00:00Z" },
    }]);
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("MiniMax M3")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "设置价格" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "发布模型" })).not.toBeInTheDocument();
  });

  it("在大模型服务页提供 LLM 网关超链接，并保留价格更新入口", async () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("href", "http://localhost:9300/");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "大模型服务" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("title", expect.stringContaining("管理凭据"));
  });
});
