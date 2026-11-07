import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlatformProvidersApi } from "./usePlatformProvidersApi";

const client = vi.hoisted(() => ({
  get: vi.fn(),
  listGet: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../api/client", () => ({ createOperationApiClient: () => client }));
vi.mock("../../auth/session", () => ({ useSession: () => ({ token: "t" }) }));

const BASE = "/api/operation/providers/p1";

describe("usePlatformProvidersApi 渠道与模型能力接口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.listGet.mockResolvedValue({ items: [{ id: 1 }] });
    client.post.mockResolvedValue(null);
  });

  it("渠道读取、增删改、启停与测试走 /channels 路径", async () => {
    const api = renderHook(() => usePlatformProvidersApi()).result.current;
    await expect(api.channelTypes("p1")).resolves.toEqual([{ id: 1 }]);
    expect(client.listGet).toHaveBeenCalledWith(`${BASE}/channel-types`);
    await expect(api.channels("p1")).resolves.toEqual([{ id: 1 }]);
    expect(client.listGet).toHaveBeenCalledWith(`${BASE}/channels`);

    const input = { name: "c" } as never;
    await api.createChannel("p1", input);
    expect(client.post).toHaveBeenCalledWith(`${BASE}/channels`, { body: input });
    await api.updateChannel("p1", 3, input);
    expect(client.put).toHaveBeenCalledWith(`${BASE}/channels/3`, { body: input });
    await api.deleteChannel("p1", 3);
    expect(client.del).toHaveBeenCalledWith(`${BASE}/channels/3`);
    await api.setChannelEnabled("p1", 3, false);
    expect(client.post).toHaveBeenCalledWith(`${BASE}/channels/3/status`, { body: { enabled: false } });
    await api.testChannel("p1", 3);
    expect(client.post).toHaveBeenCalledWith(`${BASE}/channels/3/test`, { body: { model: null } });
    await api.testChannel("p1", 3, "m");
    expect(client.post).toHaveBeenCalledWith(`${BASE}/channels/3/test`, { body: { model: "m" } });
  });

  it("拉取上游模型列表，空响应返回空数组", async () => {
    const api = renderHook(() => usePlatformProvidersApi()).result.current;
    client.post.mockResolvedValueOnce({ models: ["a", "b"] });
    await expect(api.upstreamModels("p1", { channel_id: 3 })).resolves.toEqual(["a", "b"]);
    expect(client.post).toHaveBeenCalledWith(`${BASE}/channels/upstream-models`, { body: { channel_id: 3 } });
    await expect(api.upstreamModels("p1", { channel_id: 3 })).resolves.toEqual([]);
  });

  it("模型能力按模型 id 编码路径后整体写入", async () => {
    const api = renderHook(() => usePlatformProvidersApi()).result.current;
    const input = { reasoning: false } as never;
    await api.updateModelCapabilities("p1", "org/model a", input);
    expect(client.put).toHaveBeenCalledWith(`${BASE}/models/org%2Fmodel%20a/capabilities`, { body: input });
  });
});
