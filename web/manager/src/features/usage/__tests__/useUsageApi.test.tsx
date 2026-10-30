import React from "react";
/**
 * useUsageApi / lastLocalDaysWindow 测试：
 * - 统计请求固定带 group_by，可选 UTC 整点窗口
 * - 时间窗起止均对齐 UTC 整点
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useUsageApi } from "../useUsageApi";
import { lastLocalDaysWindow } from "../usageWindow";
import type { AuthSession } from "@aiteam/shared";

function makeSession(): SessionContextValue {
  return {
    session: { principal: { id: "u1", tenant_id: "t1", display_name: "U", status: "active", roles: ["enterprise_admin"] }, claims: { user_id: "u1", tenant_id: "t1", roles: ["enterprise_admin"], exp: 9999999999 } } as AuthSession,
    token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {},
  };
}

function setup() {
  const client: Record<string, ReturnType<typeof vi.fn>> = { get: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={makeSession()}>{children}</SessionContext.Provider>
  );
  return { client, wrapper };
}

describe("useUsageApi", () => {
  it("getStatistics 带 group_by 与时间窗", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUsageApi(), { wrapper });
    await result.current.getStatistics("employee", { window_start: "2026-10-29T16:00:00Z", window_end: "2026-10-30T03:00:00Z" });
    expect(client.get).toHaveBeenCalledWith(
      "/api/manager/usage/statistics?group_by=employee&window_start=2026-10-29T16%3A00%3A00Z&window_end=2026-10-30T03%3A00%3A00Z",
    );
  });

  it("全部时间不带时间窗", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useUsageApi(), { wrapper });
    await result.current.getStatistics("member", null);
    expect(client.get).toHaveBeenCalledWith("/api/manager/usage/statistics?group_by=member");
  });
});

describe("lastLocalDaysWindow", () => {
  it("起止均为 UTC 整点，终点为当前小时的下一个整点", () => {
    const now = new Date("2026-10-30T02:34:56.789Z");
    const today = lastLocalDaysWindow(1, now);
    const week = lastLocalDaysWindow(7, now);
    for (const value of [today.window_start, today.window_end, week.window_start, week.window_end]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
    }
    expect(today.window_end).toBe("2026-10-30T03:00:00Z");
    expect(Date.parse(today.window_start)).toBeLessThanOrEqual(now.getTime());
    expect(Date.parse(today.window_start) - Date.parse(week.window_start)).toBe(6 * 24 * 3_600_000);
  });
});
