import type { AgentApiClient } from "../../lib/api-client";
import { listConversations as listChatConversations } from "../chat/useChatApi";

export interface Conversation {
  id: string;
  title: string | null;
  state: string;
  updated_at: string;
}

export async function listConversations(client: AgentApiClient): Promise<Conversation[]> {
  const result = await listChatConversations(client);
  return result.items;
}
