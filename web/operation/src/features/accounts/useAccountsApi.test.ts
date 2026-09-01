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
