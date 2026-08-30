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

  it("loads the Manager knowledge analytics projection without a workspace argument", async () => {
    const { client, wrapper } = setup();
    client.listGet.mockResolvedValue({
      items: [{
        knowledge_space_id: "ks-sales", status: "available", document_count: 2,
        ready_count: 1, failed_count: 1, processing_count: 0, deleted_count: 0,
        total_bytes: 100, total_text_chars: 80, total_chunks: 4,
        upstream_document_count: 2, upstream_ready_count: 1,
        upstream_failed_count: 1, upstream_processing_count: 0,
        last_activity_at: null, refreshed_at: "2026-08-26T00:00:00Z",
        daily_activity: [], documents: [],
      }],
      page: { next_cursor: null, has_more: false },
    });
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.getAnalytics?.("ks-sales")).resolves.toMatchObject({ document_count: 2 });
    expect(client.listGet).toHaveBeenCalledWith("/api/manager/knowledge-spaces/ks-sales/analytics");
  });

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

  it("reconciles deletion with a fresh Idempotency-Key and validates both result states", async () => {
    const { client, wrapper } = setup();
    client.post
      .mockResolvedValueOnce({ ...OPERATION, upstream_status: "present" })
      .mockResolvedValueOnce({ ...OPERATION, status: "completed", document_status: "deleted", upstream_status: "deleted" });
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.reconcileDeleteDocument("ks-sales", "doc-1")).resolves.toMatchObject({
      status: "pending",
      document_status: "deleting",
      upstream_status: "present",
    });
    await expect(result.current.reconcileDeleteDocument("ks-sales", "doc-1")).resolves.toMatchObject({
      status: "completed",
      document_status: "deleted",
      upstream_status: "deleted",
    });

    const firstKey = client.post.mock.calls[0]![1].idempotencyKey;
    const secondKey = client.post.mock.calls[1]![1].idempotencyKey;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/api/manager/knowledge-spaces/ks-sales/documents/doc-1/reconcile-delete",
      { idempotencyKey: firstKey },
    );
  });

  it("rejects an invalid reconciliation result instead of treating it as completed", async () => {
    const { client, wrapper } = setup();
    client.post.mockResolvedValue({ ...OPERATION, status: "completed", document_status: "deleting", upstream_status: "present" });
    const { result } = renderHook(() => useKnowledgeApi(), { wrapper });

    await expect(result.current.reconcileDeleteDocument("ks-sales", "doc-1")).rejects.toMatchObject({
      name: "ApiError",
      status: 200,
      code: "malformed_response",
    });
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
