import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ApiClient } from "../../../api/client";
import * as clientModule from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useProvidersApi } from "../useProvidersApi";
import type { AuthSession } from "@aiteam/shared";

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
    get: vi.fn().mockResolvedValue(null),
    post: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(undefined),
    listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }),
  };
  vi.spyOn(clientModule, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
  );
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("useProvidersApi", () => {
  it("update uses the credential PUT endpoint and forwards the rotation payload", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProvidersApi(), { wrapper });
    const payload = {
      secret: "sk-rotated",
      display_name: "Relay",
      endpoint: "https://relay.example/v1",
      api_protocol: "openai-responses" as const,
      supported_models: [{ model: "gpt-4o", enabled: true }],
    };

    await result.current.update("cred-1", payload);

    expect(client.put).toHaveBeenCalledWith(
      "/api/manager/provider-credentials/cred-1",
      { body: payload },
    );
  });

  it("del uses the credential DELETE endpoint", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProvidersApi(), { wrapper });
    await result.current.del("cred-1");
    expect(client.del).toHaveBeenCalledWith("/api/manager/provider-credentials/cred-1");
  });
});
