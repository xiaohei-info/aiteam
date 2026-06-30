import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useLlmApi } from "../useLlmApi";
import type { AuthSession } from "@aiteam/shared";

function setup() {
  const sv: SessionContextValue = { session: { principal: { id:"u1", tenant_id:"t1", display_name:"U", status:"active", roles:["owner"] }, claims:{ user_id:"u1", tenant_id:"t1", roles:["owner"], exp: 9999999999 } } as AuthSession, token: "tok", signIn: () => {}, signOut: () => {}, onUnauthorized: () => {} };
  const client = { get: vi.fn().mockResolvedValue(null), listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }), post: vi.fn().mockResolvedValue(null), patch: vi.fn().mockResolvedValue(null), del: vi.fn().mockResolvedValue(null) };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <SessionContext.Provider value={sv}>{children}</SessionContext.Provider>;
  return { client, wrapper };
}

describe("useLlmApi", () => {
  it("listProviders", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.listProviders(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/llm/providers"); });
  it("createProvider", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.createProvider({ name: "p", provider_key: "openai" }); expect(client.post).toHaveBeenCalledWith("/api/manager/llm/providers", { body: { name: "p", provider_key: "openai" } }); });
  it("patchProvider", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.patchProvider("p1", { name: "updated" }); expect(client.patch).toHaveBeenCalledWith("/api/manager/llm/providers/p1", { body: { name: "updated" } }); });
  it("deleteProvider", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.deleteProvider("p1"); expect(client.del).toHaveBeenCalledWith("/api/manager/llm/providers/p1"); });
  it("listModels 无参数", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.listModels(); expect(client.listGet).toHaveBeenCalledWith("/api/manager/llm/models"); });
  it("listModels 带 providerId", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.listModels("p1"); expect(client.listGet).toHaveBeenCalledWith("/api/manager/llm/models?provider_id=p1"); });
  it("createModel", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.createModel("p1", { model_uid: "gpt-4", model_name: "GPT-4" }); expect(client.post).toHaveBeenCalledWith("/api/manager/llm/providers/p1/models", { body: { model_uid: "gpt-4", model_name: "GPT-4" } }); });
  it("deleteModel", async () => { const { client, wrapper } = setup(); const { result } = renderHook(() => useLlmApi(), { wrapper }); await result.current.deleteModel("m1"); expect(client.del).toHaveBeenCalledWith("/api/manager/llm/models/m1"); });
});
