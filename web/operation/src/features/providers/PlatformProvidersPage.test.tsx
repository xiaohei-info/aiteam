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

  it("在大模型服务页提供 LLM 网关超链接，并保留价格更新入口", async () => {
    render(<MemoryRouter><PlatformProvidersPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("href", "http://localhost:9300/");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "大模型服务" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "打开 LLM 网关" })).toHaveAttribute("title", expect.stringContaining("管理凭据"));
  });
});
