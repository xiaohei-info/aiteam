import React from "react";
/**
 * useBillingApi 分支覆盖测试：
 * 验证 hook 返回的每个方法都调用正确的 client HTTP 方法 + 路径。
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useBillingApi } from "../useBillingApi";
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
    del: vi.fn().mockResolvedValue(null),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>
  );
  return { sv, client, wrapper };
}

describe("useBillingApi", () => {
  it("getOverview 调用 client.get 带 period 参数", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.getOverview("week");
    expect(client.get).toHaveBeenCalledWith("/api/manager/billing/usage/overview?period=week");
  });

  it("getOverview 默认 period=month", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.getOverview();
    expect(client.get).toHaveBeenCalledWith("/api/manager/billing/usage/overview?period=month");
  });

  it("getRecords 调用 listGet 带 period 和可选 employee_id", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.getRecords("week", "emp-1");
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/billing/usage/records?period=week&employee_id=emp-1");
  });

  it("getRecords 无 employee_id 时只带 period", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.getRecords("month");
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/billing/usage/records?period=month");
  });

  it("getBalance 调用 client.get", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.getBalance();
    expect(client.get).toHaveBeenCalledWith("/api/manager/billing/balance");
  });

  it("listRecharges 调用 listGet", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.listRecharges();
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/billing/recharges");
  });

  it("createRecharge 调用 client.post", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useBillingApi(), { wrapper });
    await result.current.createRecharge(100, "wechat_pay");
    expect(client.post).toHaveBeenCalledWith("/api/manager/billing/recharges", { body: { amount: 100, payment_method: "wechat_pay" } });
  });
});
