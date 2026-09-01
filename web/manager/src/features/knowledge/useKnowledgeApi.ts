import { useMemo } from "react";
import { ApiError } from "@aiteam/shared";
import { createManagerApiClient, type ApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { KnowledgeSpace } from "./types";
import {
  isKnowledgeDocumentOperation,
  type KnowledgeDocument,
  type KnowledgeDocumentOperation,
  type KnowledgeImportUrl,
  type KnowledgeIngestionJob,
  type KnowledgeAnalytics,
} from "./types";

const BASE = "/api/manager/knowledge-spaces";
export interface KnowledgeApi {
  list: () => Promise<KnowledgeSpace[]>;
  listDocuments: (id: string) => Promise<KnowledgeDocument[]>;
  /** Safe Manager projection; the endpoint returns one item in a list envelope. */
  getAnalytics?: (id: string) => Promise<import("./types").KnowledgeAnalytics | null>;
  uploadDocument: (id: string, file: File, displayName?: string) => Promise<KnowledgeDocument | null>;
  importUrl: (id: string, body: KnowledgeImportUrl) => Promise<KnowledgeDocument | null>;
  deleteDocument: (id: string, docId: string) => Promise<KnowledgeDocumentOperation>;
  reconcileDeleteDocument: (id: string, docId: string) => Promise<KnowledgeDocumentOperation>;
  reindexDocument: (id: string, docId: string) => Promise<KnowledgeDocumentOperation>;
  getIngestion: (id: string, docId: string) => Promise<KnowledgeIngestionJob | null>;
  // Manager exposes enterprise document intake/lifecycle APIs only; citation text is read by Agent Pi knowledge_get.
}

function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function parseKnowledgeDocumentOperation(value: unknown): KnowledgeDocumentOperation {
  if (!isKnowledgeDocumentOperation(value)) {
    throw ApiError.malformed(200, "知识文档操作响应不是合法 operation envelope");
  }
  return value;
}

export function parseDeleteReconciliationOperation(value: unknown): KnowledgeDocumentOperation {
  const operation = parseKnowledgeDocumentOperation(value);
  if (
    operation.operation !== "delete"
    || (operation.status === "pending"
      && (operation.document_status !== "deleting"
        || !["present", "deletion_started", "busy"].includes(operation.upstream_status ?? "")))
    || (operation.status === "completed"
      && (operation.document_status !== "deleted" || operation.upstream_status !== "deleted"))
    || (operation.status !== "pending" && operation.status !== "completed")
  ) {
    throw ApiError.malformed(200, "知识文档删除核对响应不是合法 operation envelope");
  }
  return operation;
}

function operationFrom(
  request: Promise<KnowledgeDocumentOperation | null> | KnowledgeDocumentOperation | null,
  parse: (value: unknown) => KnowledgeDocumentOperation = parseKnowledgeDocumentOperation,
): Promise<KnowledgeDocumentOperation> {
  return Promise.resolve(request).then(parse);
}

export function createKnowledgeApi(c: ApiClient): KnowledgeApi {
  return {
    async list() { return (await c.listGet<KnowledgeSpace>(BASE)).items; },
    async listDocuments(id) { return (await c.listGet<KnowledgeDocument>(`${BASE}/${id}/documents`)).items; },
    async getAnalytics(id) {
      return (await c.listGet<KnowledgeAnalytics>(`${BASE}/${id}/analytics`)).items[0] ?? null;
    },
    async uploadDocument(id, file, displayName) {
      const form = new FormData();
      form.append("file", file);
      if (displayName) form.append("display_name", displayName);
      return c.post<KnowledgeDocument>(`${BASE}/${id}/documents`, { body: form });
    },
    async importUrl(id, body) { return c.post<KnowledgeDocument>(`${BASE}/${id}/documents/url`, { body }); },
    deleteDocument: (id, docId) => operationFrom(c.del<KnowledgeDocumentOperation>(
      `${BASE}/${id}/documents/${docId}`,
      { idempotencyKey: idempotencyKey() },
    )),
    reconcileDeleteDocument: (id, docId) => operationFrom(c.post<KnowledgeDocumentOperation>(
      `${BASE}/${id}/documents/${docId}/reconcile-delete`,
      { idempotencyKey: idempotencyKey() },
    ), parseDeleteReconciliationOperation),
    reindexDocument: (id, docId) => operationFrom(c.post<KnowledgeDocumentOperation>(
      `${BASE}/${id}/documents/${docId}/reindex`,
      { idempotencyKey: idempotencyKey() },
    )),
    async getIngestion(id, docId) { return c.get<KnowledgeIngestionJob>(`${BASE}/${id}/documents/${docId}/ingestion`); },
  };
}
export function useKnowledgeApi(): KnowledgeApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => createKnowledgeApi(
    createManagerApiClient({ getToken: () => token, onUnauthorized }),
  ), [token, onUnauthorized]);
}
