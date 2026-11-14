import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountsApi } from "./useAccountsApi";

vi.mock("../../auth/session.js", () => ({
  useSession: () => ({ token: "token", onUnauthorized: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("useAccountsApi model access", () => {
  it("reads and updates enterprise model access through the operation API", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({
        data: {
          enterprise_id: "ent-1",
          tenant_id: "tenant-1",
          allowed_model_refs: [],
        },
      }), { headers: { "content-type": "application/json" } });
    }));

    const { result } = renderHook(() => useAccountsApi());
    const refs = [{ provider_id: "p1", provider_version: 1, model_id: "m1", model_version: 1 }];
    await expect(result.current.getModelAccess?.("ent-1")).resolves.toMatchObject({ enterprise_id: "ent-1" });
    await expect(result.current.setModelAccess?.("ent-1", refs)).resolves.toMatchObject({ enterprise_id: "ent-1" });

    expect(calls[0]?.[0]).toBe("/api/operation/admin/enterprises/ent-1/model-access");
    expect(calls[0]?.[1]?.method).toBe("GET");
    expect(calls[1]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ allowed_model_refs: refs });
  });
});

describe("useAccountsApi enterprise actions", () => {
  it("maps dialog payloads to the backend action schema and sends an idempotency key", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ data: { org_id: "ent-1", action: "x" } }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const { result } = renderHook(() => useAccountsApi());
    await result.current.doAction("ent-1", { action: "close", reason: " 合同到期 " });
    await result.current.doAction("ent-1", { action: "suspend", reason: "" });
    await result.current.doAction("ent-1", { action: "adjust_quota", quota: "1000" });
    await result.current.doAction("ent-1", { action: "recharge", amount: "100", payment_method: "bank_transfer" });
    await result.current.doAction("ent-1", { action: "ban", message: "违规" });

    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { action: "close", message: "合同到期" },
      { action: "suspend" },
      { action: "adjust_quota", amount: "1000" },
      { action: "recharge", amount: "100" },
      { action: "ban", message: "违规" },
    ]);
    expect(calls.every(([url]) => url === "/api/operation/admin/enterprises/ent-1/actions")).toBe(true);
    const keys = calls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
