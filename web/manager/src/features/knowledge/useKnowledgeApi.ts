import { useMemo } from "react";
import { ApiError } from "@aiteam/shared";
import { createManagerApiClient, type ApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { KnowledgeBinding, KnowledgeSpace, KnowledgeSpaceCreate, BindingCreate } from "./types";
import {
  isKnowledgeDocumentOperation,
  type KnowledgeDocument,
  type KnowledgeDocumentOperation,
  type KnowledgeImportUrl,
  type KnowledgeIngestionJob,
  type KnowledgeDocumentBinding,
} from "./types";

const BASE = "/api/manager/knowledge-spaces";
export interface KnowledgeApi {
  list: () => Promise<KnowledgeSpace[]>;
  create: (input: KnowledgeSpaceCreate) => Promise<KnowledgeSpace | null>;
  del: (id: string) => Promise<void>;
  listBindings: (id: string) => Promise<KnowledgeBinding[]>;
  bind: (id: string, input: BindingCreate) => Promise<KnowledgeBinding | null>;
  unbind: (id: string, type: string, rid: string) => Promise<void>;
  listDocuments: (id: string) => Promise<KnowledgeDocument[]>;
  uploadDocument: (id: string, file: File, displayName?: string) => Promise<KnowledgeDocument | null>;
  importUrl: (id: string, body: KnowledgeImportUrl) => Promise<KnowledgeDocument | null>;
  deleteDocument: (id: string, docId: string) => Promise<KnowledgeDocumentOperation>;
  reindexDocument: (id: string, docId: string) => Promise<KnowledgeDocumentOperation>;
  retryDocument: (id: string, docId: string) => Promise<KnowledgeDocument | null>;
  getIngestion: (id: string, docId: string) => Promise<KnowledgeIngestionJob | null>;
  listDocumentBindings: (id: string, docId: string) => Promise<KnowledgeDocumentBinding[]>;
  // Manager exposes document intake/binding APIs only; citation text is read by Agent Pi knowledge_get.
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

function operationFrom<T>(request: Promise<T | null> | T | null): Promise<KnowledgeDocumentOperation> {
  return Promise.resolve(request).then(parseKnowledgeDocumentOperation);
}

export function createKnowledgeApi(c: ApiClient): KnowledgeApi {
  return {
    async list() { return (await c.listGet<KnowledgeSpace>(BASE)).items; },
    create: (input) => c.post<KnowledgeSpace>(BASE, { body: input }),
    async del(id) { await c.del(`${BASE}/${id}`); },
    async listBindings(id) { return (await c.listGet<KnowledgeBinding>(`${BASE}/${id}/bindings`)).items; },
    bind: (id, input) => c.post<KnowledgeBinding>(`${BASE}/${id}/bindings`, { body: { ...input, knowledge_space_id: id } }),
    async unbind(id, type, rid) { await c.del(`${BASE}/${id}/bindings/${type}/${rid}`); },
    async listDocuments(id) { return (await c.listGet<KnowledgeDocument>(`${BASE}/${id}/documents`)).items; },
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
    reindexDocument: (id, docId) => operationFrom(c.post<KnowledgeDocumentOperation>(
      `${BASE}/${id}/documents/${docId}/reindex`,
      { idempotencyKey: idempotencyKey() },
    )),
    async retryDocument(id, docId) { return c.post<KnowledgeDocument>(`${BASE}/${id}/documents/${docId}/retry`); },
    async getIngestion(id, docId) { return c.get<KnowledgeIngestionJob>(`${BASE}/${id}/documents/${docId}/ingestion`); },
    async listDocumentBindings(id, docId) { return (await c.listGet<KnowledgeDocumentBinding>(`${BASE}/${id}/documents/${docId}/bindings`)).items; },
  };
}
export function useKnowledgeApi(): KnowledgeApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => createKnowledgeApi(
    createManagerApiClient({ getToken: () => token, onUnauthorized }),
  ), [token, onUnauthorized]);
}
