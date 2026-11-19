import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listGet = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock("../../api/client", () => ({
  createOperationApiClient: vi.fn(() => ({ listGet, post, put })),
}));
vi.mock("../../auth/session", () => ({
  useSession: () => ({ token: "tok" }),
}));

import { useMcpMarketApi } from "./useMcpMarketApi";

describe("useMcpMarketApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({});
    put.mockResolvedValue({});
  });

  it("list 把 items 归一化成数组", async () => {
    listGet.mockResolvedValue({ items: [{ server_id: "s1" }] });
    const { result } = renderHook(() => useMcpMarketApi());
    await expect(result.current.list()).resolves.toEqual([{ server_id: "s1" }]);
    expect(listGet).toHaveBeenCalledWith("/api/operation/mcp-market/servers");
  });

  it("list 缺 items 时回退空数组", async () => {
    listGet.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMcpMarketApi());
    await expect(result.current.list()).resolves.toEqual([]);
  });

  it("create / update / publish / unpublish 路径与编码", async () => {
    const { result } = renderHook(() => useMcpMarketApi());
    const body = { ref: "cr", display_name: "CRM", url: "https://x/mcp", tools: [], auth: "none" } as never;
    await result.current.create(body);
    expect(post).toHaveBeenCalledWith("/api/operation/mcp-market/servers", { body });
    await result.current.update("a b", body);
    expect(put).toHaveBeenCalledWith("/api/operation/mcp-market/servers/a%20b", { body });
    await result.current.publish("s1");
    expect(post).toHaveBeenCalledWith("/api/operation/mcp-market/servers/s1/publish");
    await result.current.unpublish("s1");
    expect(post).toHaveBeenCalledWith("/api/operation/mcp-market/servers/s1/unpublish");
  });

  it("probe 打到探测端点", async () => {
    post.mockResolvedValue({ auth: "none" });
    const { result } = renderHook(() => useMcpMarketApi());
    await expect(result.current.probe({ url: "https://x/mcp" } as never)).resolves.toEqual({ auth: "none" });
    expect(post).toHaveBeenCalledWith("/api/operation/mcp-market/probe", { body: { url: "https://x/mcp" } });
  });
});
