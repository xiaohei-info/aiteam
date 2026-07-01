import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { KnowledgeBinding, KnowledgeSpace, KnowledgeSpaceCreate, BindingCreate } from "./types";
import type {
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeImportUrl,
  KnowledgeIngestionJob,
  KnowledgeDocumentBinding,
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
  retryDocument: (id: string, docId: string) => Promise<KnowledgeDocument | null>;
  getIngestion: (id: string, docId: string) => Promise<KnowledgeIngestionJob | null>;
  listDocumentBindings: (id: string, docId: string) => Promise<KnowledgeDocumentBinding[]>;
}
export function useKnowledgeApi(): KnowledgeApi {
  const { token, onUnauthorized } = useSession();
  return useMemo(() => {
    const c = createManagerApiClient({ getToken: () => token, onUnauthorized });
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
      async retryDocument(id, docId) { return c.post<KnowledgeDocument>(`${BASE}/${id}/documents/${docId}/retry`); },
      async getIngestion(id, docId) { return c.get<KnowledgeIngestionJob>(`${BASE}/${id}/documents/${docId}/ingestion`); },
      async listDocumentBindings(id, docId) { return (await c.listGet<KnowledgeDocumentBinding>(`${BASE}/${id}/documents/${docId}/bindings`)).items; },
    };
  }, [token, onUnauthorized]);
}
