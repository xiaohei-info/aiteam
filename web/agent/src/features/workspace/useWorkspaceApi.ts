import type { AgentApiClient } from "../../lib/api-client";
import { listConversations as listChatConversations, type Conversation } from "../chat/useChatApi";

export type { Conversation };

export async function listConversations(client: AgentApiClient): Promise<Conversation[]> {
  const result = await listChatConversations(client);
  return result.items;
}
