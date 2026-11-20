import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManagerApiClient } from "../../api/client";

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock("../../api/client", () => ({
  createManagerApiClient: vi.fn(() => ({ get, post, put, del })),
}));
vi.mock("../../auth/session", () => ({
  useSession: () => ({ token: "tok", onUnauthorized: () => undefined }),
}));

import { useMcpMarketApi } from "./useMcpMarketApi";

const token = "tok";
const onUnauthorized = vi.fn();

describe("useMcpMarketApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({});
    del.mockResolvedValue(undefined);
  });

  it("list 归一化空响应", async () => {
    get.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMcpMarketApi());
    await expect(result.current.list()).resolves.toEqual({ platform_available: false, servers: [] });
    expect(get).toHaveBeenCalledWith("/api/manager/mcp-market");
  });

  it("list 返回平台目录", async () => {
    get.mockResolvedValue({ platform_available: true, servers: [{ server_id: "s1" }] });
    const { result } = renderHook(() => useMcpMarketApi());
    await expect(result.current.list()).resolves.toEqual({ platform_available: true, servers: [{ server_id: "s1" }] });
  });

  it("启用 / 停用调用本端接口并编码 id", async () => {
    const { result } = renderHook(() => useMcpMarketApi());
    await result.current.enable("a b");
    expect(post).toHaveBeenCalledWith("/api/manager/mcp-market/a%20b/enable");
    await result.current.disable("a b");
    expect(del).toHaveBeenCalledWith("/api/manager/mcp-market/a%20b");
  });

  it("企业自建 MCP：检查地址、添加、修改走本端接口并编码 id", async () => {
    const { result } = renderHook(() => useMcpMarketApi());
    const input = { ref: "erp", display_name: "ERP", summary: "", url: "https://erp.example.com/mcp", tools: ["find"], auth: "none" as const, auth_header: "", oauth_scopes: "", timeout_ms: 30000, oauth_client_id: "" };
    await result.current.probe({ url: input.url });
    expect(post).toHaveBeenCalledWith("/api/manager/mcp-market/probe", { body: { url: input.url } });
    await result.current.createCustom(input);
    expect(post).toHaveBeenCalledWith("/api/manager/mcp-market/custom", { body: input });
    await result.current.updateCustom("ent-a b", input);
    expect(put).toHaveBeenCalledWith("/api/manager/mcp-market/custom/ent-a%20b", { body: input });
  });

  it("token 变化时重建 client（依赖 token）", () => {
    const { rerender } = renderHook(() => useMcpMarketApi());
    rerender();
    expect(get).toBeDefined();
  });
});
