import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useGovernanceApi } from "../useGovernanceApi";
import type { AuthSession } from "@aiteam/shared";

function setup() {
  const sv: SessionContextValue = { session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
  const client = { listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }), post: vi.fn().mockResolvedValue(null), del: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>;
  return { client, wrapper };
}

describe("useGovernanceApi", () => {
  it("listUsageRollups", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); await result.current.listUsageRollups(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/usage/rollup/list"); });
  it("listAudits", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); await result.current.listAudits(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/audits"); });
  it("listQuotas", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); await result.current.listQuotas(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/quota-policies"); });
  it("createQuota", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); const input = { policy_slug: "q", display_name: "Q", scope: "tenant" as const, window_start: "2026-01-01", window_end: "2026-03-01", dimensions: { max_tokens: 1000000 }, enforcement: "soft" as const, status: "active" as const }; await result.current.createQuota(input); expect(client.post).toHaveBeenCalledWith("/api/manager/quota-policies", { body: input }); });
  it("deleteQuota", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); await result.current.deleteQuota("q1"); expect(client.del).toHaveBeenCalledWith("/api/manager/quota-policies/q1"); });
  it("evaluateQuota", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useGovernanceApi(), { wrapper }); await result.current.evaluateQuota("q1", "2026-01-01", "2026-02-01"); expect(client.post).toHaveBeenCalledWith("/api/manager/quota-policies/q1/evaluate", { query: { window_start: "2026-01-01", window_end: "2026-02-01" } }); });
});
