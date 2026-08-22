import React from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthSession } from "@aiteam/shared";
import type { ApiClient } from "../../../api/client";
import * as clientMod from "../../../api/client";
import { SessionContext, type SessionContextValue } from "../../../auth/session";
import { useKnowledgeApi } from "../useKnowledgeApi";

const OPERATION = {
  operation_id: "op-1",
  operation: "delete",
  idempotency_key: "idem-server",
  tenant_id: "t1",
  knowledge_space_id: "ks-sales",
  document_id: "doc-1",
  status: "pending",
  document_status: "deleting",
  upstream_status: "deletion_started",
  error_code: null,
  error_message: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
} as const;

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
    listGet: vi.fn().mockResolvedValue({ items: [], page: { next_cursor: null, has_more: false } }),
    post: vi.fn().mockResolvedValue({ ...OPERATION, operation: "reindex", status: "completed", document_status: "ready" }),
    patch: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(OPERATION),
  };
  vi.spyOn(clientMod, "createManagerApiClient").mockReturnValue(client as unknown as ApiClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
  );
  return { client, wrapper };
}

describe("useKnowledgeApi document lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deletes with a UUID Idempotency-Key and validates the operation data", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.deleteDocument("ks-sales", "doc-1")).resolves.toMatchObject({
      operation_id: "op-1",
      document_status: "deleting",
    });
    expect(client.del).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-1",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    );
  });

  it("reindexes through the lifecycle endpoint with a UUID Idempotency-Key", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.reindexDocument("ks-sales", "doc-1")).resolves.toMatchObject({
      operation: "reindex",
      status: "completed",
    });
    expect(client.post).toHaveBeenCalledWith(
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-1/reindex",
      { idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    );
  });

  it("rejects a missing or malformed operation envelope instead of returning null", async () => {
    const { client, wrapper } = setup();
    client.del.mockResolvedValue({ operation_id: "op-1" });
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.deleteDocument("ks-sales", "doc-1")).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      code: "malformed_response",
    });
    expect(client.del).toHaveBeenCalledOnce();
  });
});
