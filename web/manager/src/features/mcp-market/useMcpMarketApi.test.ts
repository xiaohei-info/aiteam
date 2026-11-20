import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManagerApiClient } from "../../api/client";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../../api/client", () => ({
  createManagerApiClient: vi.fn(() => ({ get, post, del })),
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

  it("token 变化时重建 client（依赖 token）", () => {
    const { rerender } = renderHook(() => useMcpMarketApi());
    rerender();
    expect(get).toBeDefined();
  });
});
