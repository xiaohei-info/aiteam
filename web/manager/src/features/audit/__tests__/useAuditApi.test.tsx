import React from "react";
/**
 * useAuditApi 分支覆盖测试：
 * 验证 list 方法调用正确的 client.listGet 路径与参数。
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useAuditApi } from "../useAuditApi";
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
    listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>
  );
  return { sv, client, wrapper };
}

describe("useAuditApi", () => {
  it("list 无参数时调用 listGet", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAuditApi(), { wrapper });
    await result.current.list();
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/audit-events");
  });

  it("list 带 event_type", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAuditApi(), { wrapper });
    await result.current.list({ event_type: "login" });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/audit-events?event_type=login");
  });

  it("list 带 page", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAuditApi(), { wrapper });
    await result.current.list({ page: 3 });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/audit-events?page=3");
  });

  it("list 带 event_type 和 page", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAuditApi(), { wrapper });
    await result.current.list({ event_type: "login", page: 2 });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/audit-events?event_type=login&page=2");
  });
});
