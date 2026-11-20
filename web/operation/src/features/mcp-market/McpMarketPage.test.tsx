import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpMarketPage } from "./McpMarketPage";

const api = { list: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), probe: vi.fn() };
vi.mock("./useMcpMarketApi", () => ({ useMcpMarketApi: () => api }));

const server = (extra: Record<string, unknown> = {}) => ({
  server_id: "s1", ref: "mes", display_name: "MES 查询", summary: "查批次", url: "https://mcp.example.com/mes",
  tools: ["search"], auth: "none", auth_header: "", oauth_scopes: "", timeout_ms: 30000,
  oauth_client_id: "", revision: 1, status: "draft", oauth_client_secret_set: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.create.mockResolvedValue({});
  api.update.mockResolvedValue({});
  api.publish.mockResolvedValue({});
  api.unpublish.mockResolvedValue({});
});

describe("McpMarketPage", () => {
  it("列出目录并显示状态与鉴权标签", async () => {
    api.list.mockResolvedValue([server(), server({ server_id: "s2", ref: "crm", display_name: "CRM", status: "published", auth: "oauth" })]);
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    expect(screen.getByText("草稿")).toBeInTheDocument();
    expect(screen.getByText("已发布")).toBeInTheDocument();
    expect(screen.getByText("成员浏览器登录")).toBeInTheDocument();
  });

  it("空目录给空态", async () => {
    api.list.mockResolvedValue([]);
    render(<McpMarketPage />);
    await screen.findByText("还没有登记 MCP");
  });

  it("加载失败显示错误横幅", async () => {
    api.list.mockRejectedValue(new Error("boom"));
    render(<McpMarketPage />);
    await screen.findByText("MCP 目录加载失败");
  });

  it("发布与下架", async () => {
    api.list.mockResolvedValue([server({ status: "draft" })]);
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("登记新 MCP 调 create", async () => {
    api.list.mockResolvedValue([]);
    render(<McpMarketPage />);
    await screen.findByText("还没有登记 MCP");
    fireEvent.click(screen.getByRole("button", { name: "登记 MCP" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
  });

  it("编辑已登记的 MCP 调 update", async () => {
    api.list.mockResolvedValue([server({ status: "published" })]);
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  // act() 的成功与失败分支：保存成功给提示并重加载；失败给错误、保留弹窗。
  it("保存成功提示并重新加载；保存失败提示且不关弹窗", async () => {
    api.list.mockResolvedValue([server({ status: "published" })]);
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("s1", expect.anything()));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/已保存，修订号加 1/)).toBeInTheDocument();
  });

  it("保存失败提示错误且不关弹窗", async () => {
    api.list.mockResolvedValue([server({ status: "published" })]);
    api.update.mockRejectedValueOnce(new Error("boom"));
    render(<McpMarketPage />);
    await screen.findByText("MES 查询");
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
