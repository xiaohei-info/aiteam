import type { AgentApiClient } from "../../lib/api-client";
import { makeLocalConversation, writeLocalConversation } from "../chat/conversation-store";

export interface SolutionProjection {
  solution_instance_id: string;
  display_name: string;
  version: string;
  expert_employee_ids?: string[];
}

export interface ModelPolicy {
  model?: string | null;
  provider_ref?: string | null;
  thinking_level?: string | null;
}

export interface LoadedExpertProjection {
  employee_id: string;
  tenant_id: string;
  version: string;
  handle: string;
  display_name: string;
  synced_at?: string | null;
  revoked: boolean;
  model_policy?: ModelPolicy | null;
}

export interface GroupExpert {
  handle: string;
  employee_id?: string;
  display_name?: string;
  system_prompt?: string | null;
  model?: string | null;
}

export async function listLoadedExperts(client: AgentApiClient): Promise<LoadedExpertProjection[]> {
  const result = await client.listGet<LoadedExpertProjection>("/api/agent/grants/experts");
  return result.items;
}

export interface SyncGrantsResult {
  ok: boolean;
  upserted: number;
  revoked: number;
  error?: string | null;
}

export async function syncGrants(
  client: AgentApiClient,
  input: { tenant_id: string; member_id: string },
): Promise<SyncGrantsResult> {
  const result = await client.post<SyncGrantsResult>("/api/agent/grants/sync", { body: input });
  if (result === null) throw new Error("syncGrants: empty envelope");
  return result;
}

export async function listSolutionInstances(client: AgentApiClient): Promise<SolutionProjection[]> {
  const result = await client.listGet<SolutionProjection>("/api/agent/grants/solutions");
  return result.items;
}

export function createLocalGroupConversation(input: {
  title?: string | null;
  solution_instance_id?: string | null;
}): import("../chat/useChatApi").Conversation {
  const conversation = makeLocalConversation({
    title: input.title,
    collaboration_mode: input.solution_instance_id ? "orchestrated" : "free",
    solution_instance_id: input.solution_instance_id,
  });
  writeLocalConversation(conversation);
  return conversation;
}
