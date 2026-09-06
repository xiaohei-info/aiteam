import React from "react";
/**
 * useMemoryApi 分支覆盖测试：
 * 验证 list/create/update/delete 调用正确的 client 方法。
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useMemoryApi } from "../useMemoryApi";
import type { AuthSession } from "@aiteam/shared";
import type { MemoryWriteAcknowledgement } from "../types";

function makeSession(): SessionContextValue {
  return {
    session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession,
    token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
  };
}

function setup() {
  const sv = makeSession();
  const client: Record<string, ReturnType<typeof vi.fn>> = {
    get: vi.fn().mockResolvedValue(null),
    listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }),
    post: vi.fn().mockResolvedValue(null),
    patch: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(null),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>
  );
  return { sv, client, wrapper };
}

describe("useMemoryApi", () => {
  it("loads per-employee Hindsight analytics through the Manager list envelope", async () => {
    const { client, wrapper } = setup();
    client.listGet!.mockResolvedValue({
      items: [{
        status: "available", employee_count: 1, total_memory_count: 2,
        refreshed_at: "2026-08-26T00:00:00Z", unavailable_employee_count: 0,
        employees: [{
          employee_id: "emp-1", display_name: "专家", memory_count: 2,
          state_counts: { valid: 2 }, category_counts: { preference: 2 },
          latest_created_at: "2026-08-26T00:00:00Z", oldest_created_at: "2026-08-20T00:00:00Z",
          latest_used_at: null, average_importance: 0.8, max_importance: 1, truncated: false,
        }],
      }],
      page: { next_cursor: null, has_more: false },
    });
    const { result } = renderHook(() => useMemoryApi(), { wrapper });

    await expect(result.current.getAnalytics?.()).resolves.toMatchObject({ total_memory_count: 2 });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories/analytics");
  });

  it("list requires employee_id and calls listGet", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ employee_id: "emp-1" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?employee_id=emp-1");
  });

  it("list 带 keyword", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ employee_id: "emp-1", keyword: "test" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?employee_id=emp-1&keyword=test");
  });

  it("list 带 employee_id 和 keyword", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ employee_id: "emp-1", keyword: "hello" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?employee_id=emp-1&keyword=hello");
  });

  it("create 调用 client.post 并消费异步 acknowledgment", async () => {
    const { client, wrapper } = setup();
    const acknowledgement: MemoryWriteAcknowledgement = { success: true, async: true, operation_id: "op-1" };
    client.post!.mockResolvedValue(acknowledgement);
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    const body = { employee_id: "emp-1", content: "test", metadata: { source: "fixture" } };
    await expect(result.current.create(body)).resolves.toEqual(acknowledgement);
    expect(client.post).toHaveBeenCalledWith("/api/manager/memories", { body });
  });

  it("update 调用 client.patch", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.update("mem-1", { content: "updated" }, "emp-1");
    expect(client.patch).toHaveBeenCalledWith("/api/manager/memories/mem-1?employee_id=emp-1", { body: { content: "updated" } });
  });

  it("delete 调用 client.del", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.delete("mem-1", "emp-1");
    expect(client.del).toHaveBeenCalledWith("/api/manager/memories/mem-1?employee_id=emp-1");
  });

});
