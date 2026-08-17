import type { AgentApiClient } from "../../lib/api-client";
import type { KnowledgeBase, KnowledgeDocument, KnowledgeIngestion, KnowledgeSearchResult } from "./types";

export async function listKnowledgeBases(client: AgentApiClient): Promise<KnowledgeBase[]> {
  const result = await client.listGet<KnowledgeBase>("/api/agent/knowledge-bases");
  return result.items ?? [];
}

export async function searchKnowledge(
  client: AgentApiClient,
  kbId: string,
  query: string,
  topK = 5,
): Promise<KnowledgeSearchResult[]> {
  const result = await client.listGet<KnowledgeSearchResult>(
    `/api/agent/knowledge-bases/${kbId}/search?q=${encodeURIComponent(query)}&top_k=${topK}`,
  );
  return result.items ?? [];
}

export async function listDocuments(client: AgentApiClient, kbId: string): Promise<KnowledgeDocument[]> {
  const result = await client.listGet<KnowledgeDocument>(`/api/agent/knowledge-bases/${kbId}/documents`);
  return result.items ?? [];
}

export async function listIngestions(client: AgentApiClient, kbId: string): Promise<KnowledgeIngestion[]> {
  const result = await client.listGet<KnowledgeIngestion>(`/api/agent/knowledge-bases/${kbId}/ingestions`);
  return result.items ?? [];
}
