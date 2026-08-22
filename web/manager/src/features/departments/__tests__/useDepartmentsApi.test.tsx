import React from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../api/client";
import * as clientModule from "../../../api/client";
import type { AuthSession } from "@aiteam/shared";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useDepartmentsApi } from "../useDepartmentsApi";

const department = {
  id: "d1",
  department_slug: "engineering",
  display_name: "研发部",
  created_at: "2026-07-01T00:00:00Z",
};

function setup() {
  const session: SessionContextValue = {
    session: {
      principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["owner"] },
      claims: { user_id: "u1", tenant_id: "t1", roles: ["owner"], exp: 9999999999 },
    } as AuthSession,
    token: "tok",
    signIn: () => {},
    signOut: () => {},
    onUnauthorized: () => {},
  };
  const client = {
    listGet: vi.fn().mockResolvedValue({ items: [department], page: { next_cursor: null, has_more: false } }),
    get: vi.fn().mockResolvedValue(department),
    post: vi.fn().mockResolvedValue(department),
    patch: vi.fn().mockResolvedValue({ ...department, display_name: "工程部" }),
    del: vi.fn().mockResolvedValue({ deleted: "d1" }),
  };
  vi.spyOn(clientModule, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
  );
  return { client, wrapper };
}

describe("useDepartmentsApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("通过 Manager client 调用部门列表与详情", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDepartmentsApi(), { wrapper });

    await expect(result.current.listDepartments()).resolves.toEqual([department]);
    await expect(result.current.getDepartment("d1")).resolves.toEqual(department);
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/departments");
    expect(client.get).toHaveBeenCalledWith("/api/manager/departments/d1");
  });

  it("写操作使用真实部门契约路径与请求体", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDepartmentsApi(), { wrapper });

    await result.current.createDepartment({ department_slug: "sales", display_name: "销售部" });
    await result.current.updateDepartment("d1", { display_name: "工程部" });
    await result.current.deleteDepartment("d1");

    expect(client.post).toHaveBeenCalledWith("/api/manager/departments", {
      body: { department_slug: "sales", display_name: "销售部" },
    });
    expect(client.patch).toHaveBeenCalledWith("/api/manager/departments/d1", {
      body: { display_name: "工程部" },
    });
    expect(client.del).toHaveBeenCalledWith("/api/manager/departments/d1");
  });
});
