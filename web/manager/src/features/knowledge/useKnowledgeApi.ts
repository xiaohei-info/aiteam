import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { KnowledgeSpace, KnowledgeSpaceCreate, KnowledgeBinding, BindingCreate } from "./types";

const BASE = "/api/manager/knowledge-spaces";
export interface KnowledgeApi {
  list: () => Promise<KnowledgeSpace[]>;
  create: (input: KnowledgeSpaceCreate) => Promise<KnowledgeSpace | null>;
  del: (id: string) => Promise<void>;
  listBindings: (id: string) => Promise<KnowledgeBinding[]>;
  bind: (id: string, input: BindingCreate) => Promise<KnowledgeBinding | null>;
  unbind: (id: string, type: string, rid: string) => Promise<void>;
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
    };
  }, [token, onUnauthorized]);
}
