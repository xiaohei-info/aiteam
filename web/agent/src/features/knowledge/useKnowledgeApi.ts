import type { AgentApiClient } from "../../lib/api-client";
import type { KnowledgeBase, KnowledgeSearchResult } from "./types";

export async function listKnowledgeBases(client: AgentApiClient): Promise<KnowledgeBase[]> {
  const r = await client.listGet<KnowledgeBase>("/api/agent/knowledge-bases");
  return r.items ?? [];
}

export async function searchKnowledge(client: AgentApiClient, kbId: string, query: string, topK = 5): Promise<KnowledgeSearchResult[]> {
  const r = await client.listGet<KnowledgeSearchResult>(`/api/agent/knowledge-bases/${kbId}/search?q=${encodeURIComponent(query)}&top_k=${topK}`);
  return r.items ?? [];
}

export async function uploadDocument(client: AgentApiClient, kbId: string, file: File): Promise<unknown> {
  const formData = new FormData();
  formData.append("file", file);
  return client.post(`/api/agent/knowledge-bases/${kbId}/documents`, { body: formData });
}
