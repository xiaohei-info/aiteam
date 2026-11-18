import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpMarketPage } from "./McpMarketPage";

const api = { list: vi.fn(), enable: vi.fn(), disable: vi.fn() };
vi.mock("./useMcpMarketApi", () => ({ useMcpMarketApi: () => api }));

const server = (extra: Record<string, unknown> = {}) => ({
  server_id: "s1", ref: "mes", display_name: "MES 查询", summary: "查批次", url: "https://mcp.example.com/mes", tools: ["search"],
  auth: "none", auth_header: "", oauth_scopes: "", timeout_ms: 30000, oauth_client: "dynamic", platform_revision: 1, published: true, enabled: false, enabled_revision: null, update_available: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.enable.mockResolvedValue({});
  api.disable.mockResolvedValue(undefined);
});

describe("McpMarketPage", () => {
  it("启用平台 MCP；已启用且有更新时可更新或停用", async () => {
    api.list.mockResolvedValue({ platform_available: true, servers: [server(), server({ server_id: "s2", ref: "doc", display_name: "文档", enabled: true, enabled_revision: 1, platform_revision: 2, update_available: true })] });
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    expect(screen.getByText("已启用 · 有更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith("s1"));
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => expect(api.disable).toHaveBeenCalledWith("s2"));
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
  });

  it("平台不可达或已下架时只能停用，不能启用", async () => {
    api.list.mockResolvedValue({ platform_available: false, servers: [server({ enabled: true, enabled_revision: 1, published: false, platform_revision: null })] });
    render(<McpMarketPage />);
    await screen.findByText(/平台 MCP 目录暂时不可用/);
    expect(screen.getByText("已启用 · 平台已下架")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
    expect(screen.getByRole("button", { name: "停用" })).toBeInTheDocument();
  });
});
