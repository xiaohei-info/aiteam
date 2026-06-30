import type { AgentApiClient } from "../../lib/api-client";
import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeIngestion,
  KnowledgeSearchResult,
} from "./types";

export async function listKnowledgeBases(client: AgentApiClient): Promise<KnowledgeBase[]> {
  const r = await client.listGet<KnowledgeBase>("/api/agent/knowledge-bases");
  return r.items ?? [];
}

export async function searchKnowledge(
  client: AgentApiClient,
  kbId: string,
  query: string,
  topK = 5,
): Promise<KnowledgeSearchResult[]> {
  const r = await client.listGet<KnowledgeSearchResult>(
    `/api/agent/knowledge-bases/${kbId}/search?q=${encodeURIComponent(query)}&top_k=${topK}`,
  );
  return r.items ?? [];
}

export async function uploadDocument(
  client: AgentApiClient,
  kbId: string,
  file: File,
): Promise<KnowledgeDocument> {
  const formData = new FormData();
  formData.append("file", file);
  const out = await client.post<KnowledgeDocument>(`/api/agent/knowledge-bases/${kbId}/documents`, {
    body: formData,
  });
  if (!out) throw new Error("upload empty response");
  return out;
}

export async function importUrl(
  client: AgentApiClient,
  kbId: string,
  url: string,
  title?: string,
): Promise<KnowledgeDocument> {
  const out = await client.post<KnowledgeDocument>(
    `/api/agent/knowledge-bases/${kbId}/documents/url`,
    { body: { url, ...(title ? { title } : {}) } },
  );
  if (!out) throw new Error("import_url empty response");
  return out;
}

export async function listDocuments(
  client: AgentApiClient,
  kbId: string,
): Promise<KnowledgeDocument[]> {
  const r = await client.listGet<KnowledgeDocument>(`/api/agent/knowledge-bases/${kbId}/documents`);
  return r.items ?? [];
}

export async function listIngestions(
  client: AgentApiClient,
  kbId: string,
): Promise<KnowledgeIngestion[]> {
  const r = await client.listGet<KnowledgeIngestion>(
    `/api/agent/knowledge-bases/${kbId}/ingestions`,
  );
  return r.items ?? [];
}

export async function retryDocument(
  client: AgentApiClient,
  kbId: string,
  docId: string,
): Promise<KnowledgeDocument> {
  const out = await client.post<KnowledgeDocument>(
    `/api/agent/knowledge-bases/${kbId}/documents/${docId}/retry`,
    { body: {} },
  );
  if (!out) throw new Error("retry empty response");
  return out;
}
