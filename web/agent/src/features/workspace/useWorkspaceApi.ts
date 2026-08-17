import type { AgentApiClient } from "../../lib/api-client";

export interface Conversation {
  id: string;
  title: string | null;
  state: string;
  updated_at: string;
}

export async function listConversations(client: AgentApiClient): Promise<Conversation[]> {
  return (await client.listGet<Conversation>("/api/agent/conversations")).items ?? [];
}
