import React from "react";
/**
 * useMemoryApi 分支覆盖测试：
 * 验证 list/create/update/delete/bulkDelete 调用正确的 client 方法。
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useMemoryApi } from "../useMemoryApi";
import type { AuthSession } from "@aiteam/shared";

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
  it("list 无参数时调用 listGet", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list();
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories");
  });

  it("list 带 employee_id", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ employee_id: "emp-1" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?employee_id=emp-1");
  });

  it("list 带 keyword", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ keyword: "test" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?keyword=test");
  });

  it("list 带 employee_id 和 keyword", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.list({ employee_id: "emp-1", keyword: "hello" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/memories?employee_id=emp-1&keyword=hello");
  });

  it("create 调用 client.post", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    const body = { employee_id: "emp-1", content: "test", category: "note", importance: 5 };
    await result.current.create(body);
    expect(client.post).toHaveBeenCalledWith("/api/manager/memories", { body });
  });

  it("update 调用 client.patch", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.update("mem-1", { content: "updated" });
    expect(client.patch).toHaveBeenCalledWith("/api/manager/memories/mem-1", { body: { content: "updated" } });
  });

  it("delete 调用 client.del", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.delete("mem-1");
    expect(client.del).toHaveBeenCalledWith("/api/manager/memories/mem-1");
  });

  it("bulkDelete 调用 client.post", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMemoryApi(), { wrapper });
    await result.current.bulkDelete(["mem-1", "mem-2"]);
    expect(client.post).toHaveBeenCalledWith("/api/manager/memories/bulk-delete", { body: { memory_ids: ["mem-1", "mem-2"] } });
  });
});
