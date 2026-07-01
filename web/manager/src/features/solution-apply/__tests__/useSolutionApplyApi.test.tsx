import React from "react";
/**
 * useSolutionApplyApi 分支覆盖测试：验证两路只读端点的路径与 items 透传。
 * 租户边界由后端 TenantContext 裁决，前端不拼租户过滤、不跨端直调（跨端由基类拦截）。
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useSolutionApplyApi } from "../useSolutionApplyApi";
import type { AuthSession } from "@aiteam/shared";

const INSTANCE = {
  id: "si-1", solution_id: "sol-1", solution_version: "1", display_name: "方案 A", status: "applied",
};
const RECORD = {
  id: "ev-1", solution_id: "sol-1", solution_version: "1", applied_by: "u1", status: "applied",
  expert_instance_ids: ["emp-1"], detail: {}, created_at: "2026-06-30T10:00:00Z", updated_at: null,
};

function makeSession(): SessionContextValue {
  return {
    session: {
      principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
      claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: 9999999999 },
    } as AuthSession,
    token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
  };
}

function setup() {
  const sv = makeSession();
  const client: { listGet: ReturnType<typeof vi.fn> } = {
    listGet: vi.fn(),
  };
  client.listGet.mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } });
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>
  );
  return { client, wrapper };
}

describe("useSolutionApplyApi", () => {
  it("listSolutionInstances 调 /solutions 并透传 items", async () => {
    const { client, wrapper } = setup();
    client.listGet.mockResolvedValue({ items: [INSTANCE], page: { next_cursor: null, has_more: false } });
    const { result } = renderHook(() => useSolutionApplyApi(), { wrapper });
    const items = await result.current.listSolutionInstances();
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/recruit/solutions");
    expect(items).toHaveLength(1);
    expect(items[0]?.solution_id).toBe("sol-1");
  });

  it("listApplyRecords 带 solution_id 路径并透传 items", async () => {
    const { client, wrapper } = setup();
    client.listGet.mockResolvedValue({ items: [RECORD], page: { next_cursor: null, has_more: false } });
    const { result } = renderHook(() => useSolutionApplyApi(), { wrapper });
    const items = await result.current.listApplyRecords("sol-1");
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/recruit/solutions/sol-1/apply-records");
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("ev-1");
  });

  it("items 为 null 时透传为空数组", async () => {
    const { client, wrapper } = setup();
    client.listGet.mockResolvedValue({ items: null, page: { next_cursor: null, has_more: false } });
    const { result } = renderHook(() => useSolutionApplyApi(), { wrapper });
    await expect(result.current.listApplyRecords("sol-1")).resolves.toEqual([]);
  });
});
