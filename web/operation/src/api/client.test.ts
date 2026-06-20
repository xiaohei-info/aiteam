/**
 * 运营端 api-client 边界测试（W-O.1 验收：跨端直调被拦截）。
 *
 * 验证：createOperationApiClient 产出的 client 只能访问 /api/operation/* 与 /api/auth/*；
 * 任何 /api/manager/* 或 /api/agent/* 路径在请求发出前即被 ApiClient.assertOwnTierPath
 * 拦截并抛 ApiError（code=cross_tier_call_forbidden）——不会真的发 fetch。
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared";
import { createOperationApiClient } from "./client";

/** 合法的 200 空体响应 stub（放行路径到达 decode 时归一为 malformed_response）。 */
function emptyOkResponse(): Response {
  return new Response("", { status: 200 });
}

describe("operation api-client 边界门控", () => {
  it("跨端 /api/manager/* 被拦截（不发出请求）", async () => {
    const client = createOperationApiClient({
      fetch: vi.fn() as unknown as typeof fetch,
      getToken: () => "stub-token",
    });
    await expect(client.get("/api/manager/members")).rejects.toMatchObject({
      name: "ApiError",
      code: "cross_tier_call_forbidden",
    });
  });

  it("跨端 /api/agent/* 被拦截（不发出请求）", async () => {
    const client = createOperationApiClient({
      fetch: vi.fn() as unknown as typeof fetch,
      getToken: () => "stub-token",
    });
    await expect(
      client.get("/api/agent/conversations"),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "cross_tier_call_forbidden",
    });
  });

  it("跨端路径抛 ApiError 实例", async () => {
    const client = createOperationApiClient({
      fetch: vi.fn() as unknown as typeof fetch,
      getToken: () => "stub-token",
    });
    await expect(client.get("/api/manager/members")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("本端 /api/operation/* 放行（请求发出，空体 200 → malformed_response，非 cross_tier）", async () => {
    const client = createOperationApiClient({
      fetch: vi.fn().mockResolvedValue(emptyOkResponse()) as unknown as typeof fetch,
      getToken: () => "stub-token",
    });
    await expect(client.get("/api/operation/ping")).rejects.toMatchObject({
      name: "ApiError",
      code: "malformed_response",
    });
  });

  it("本端 /api/auth/* 放行（login/jwks 属本端认证面）", async () => {
    const client = createOperationApiClient({
      fetch: vi.fn().mockResolvedValue(emptyOkResponse()) as unknown as typeof fetch,
      getToken: () => "stub-token",
    });
    await expect(
      client.post("/api/auth/login", { body: {} }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "malformed_response",
    });
  });

  it("越权路径不触发 fetch（fetch 调用次数 0）", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const client = createOperationApiClient({
      fetch: fetchMock,
      getToken: () => "stub-token",
    });
    await expect(client.get("/api/manager/members")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("放行路径触发 fetch（验证放行确实发出请求）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(emptyOkResponse()) as unknown as typeof fetch;
    const client = createOperationApiClient({
      fetch: fetchMock,
      getToken: () => "stub-token",
    });
    await expect(
      client.get("/api/operation/ping"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
