/**
 * AgentApiClient 边界测试（红线 D3/D15：只调本端 /api/agent/* + /api/auth/*）。
 *
 * 验证：
 * - 越权路径（跨端直调）抛 ApiError(cross_tier_call_forbidden)，不发请求。
 * - 本端路径正常发请求并自动 unwrap envelope.data。
 * - 401 / problem+json 归一为 ApiError。
 */

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@aiteam/shared/api-client";

import { AgentApiClient } from "./api-client";

function makeClient(fetchImpl: typeof fetch): AgentApiClient {
  return new AgentApiClient({ fetch: fetchImpl, baseUrl: "http://test.local" });
}

function envelope(data: unknown): string {
  return JSON.stringify({ data });
}

describe("AgentApiClient 边界", () => {
  it("跨端直调 /api/operation/* 抛 cross_tier_call_forbidden，不发请求", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    await expect(client.get("/api/operation/anything")).rejects.toMatchObject({
      name: "ApiError",
      code: "cross_tier_call_forbidden",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("跨端直调 /api/manager/* 抛 cross_tier_call_forbidden", async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    await expect(client.get("/api/manager/anything")).rejects.toMatchObject({
      code: "cross_tier_call_forbidden",
    });
  });

  it("本端 /api/agent/* 正常发请求并 unwrap envelope.data", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(envelope({ pong: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = makeClient(fetchImpl);
    const data = await client.ping();
    expect(data).toEqual({ pong: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    const callUrl = (firstCall as unknown as [string, RequestInit])[0];
    expect(callUrl).toContain("/api/agent/ping");
  });

  it("401 problem+json 归一为 ApiError 且触发 onUnauthorized", async () => {
    const onUnauthorized = vi.fn();
    const problem = {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      code: "token_expired",
      detail: "登录已失效",
      request_id: "req-1",
    };
    const client = new AgentApiClient({
      fetch: async () =>
        new Response(JSON.stringify(problem), {
          status: 401,
          headers: { "Content-Type": "application/problem+json" },
        }),
      baseUrl: "http://test.local",
      onUnauthorized,
    });
    await expect(client.whoami()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "token_expired",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("login resolves tenant and sends Manager-compatible tenant_id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/auth/resolve-tenant-by-account")) {
        expect(JSON.parse(String(init?.body))).toEqual({ account: "alice" });
        return new Response(envelope({ tenant_id: "tenant-a" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(String(url)).toContain("/api/agent/login");
      expect(JSON.parse(String(init?.body))).toEqual({ account: "alice", password: "pw", tenant_id: "tenant-a" });
      return new Response(envelope({ token: "token", claims: { user_id: "alice", tenant_id: "tenant-a", roles: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await expect(makeClient(fetchImpl as unknown as typeof fetch).login({ account: "alice", password: "pw" })).resolves.toMatchObject({ token: "token" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reset maps UI password to old_password and preserves tenant_id", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/auth/resolve-tenant-by-account")) return new Response(envelope({ tenant_id: "tenant-a" }), { status: 200, headers: { "Content-Type": "application/json" } });
      expect(JSON.parse(String(init?.body))).toEqual({ account: "alice", tenant_id: "tenant-a", old_password: "old", new_password: "new" });
      return new Response(envelope({ token: "token", claims: { user_id: "alice", tenant_id: "tenant-a", roles: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await expect(makeClient(fetchImpl as unknown as typeof fetch).resetPassword({ account: "alice", password: "old", new_password: "new" })).resolves.toMatchObject({ token: "token" });
  });

  it("token provider 注入 Authorization header", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(envelope({ sub: "u1", exp: 9999, roles: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new AgentApiClient({
      fetch: fetchImpl as unknown as typeof fetch,
      baseUrl: "http://test.local",
      getToken: () => "abc.def.ghi",
    });
    await client.whoami();
    const firstCall = fetchImpl.mock.calls[0];
    const init = (firstCall as unknown as [string, RequestInit])[1];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer abc.def.ghi");
  });
});
