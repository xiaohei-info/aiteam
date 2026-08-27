import type { AgentApiClient } from "../../lib/api-client";
import { createConversation, type Conversation } from "../chat/useChatApi";

export interface SolutionProjection {
  solution_instance_id: string;
  display_name: string;
  version: string;
  /** New Manager projection; optional while older deployments are rolling forward. */
  coordinator_employee_id?: string | null;
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
  avatar_url?: string | null;
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
  if (!Array.isArray(result.items)) throw new Error("expert roster: invalid response");
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
  if (!Array.isArray(result.items)) throw new Error("solution list: invalid response");
  return result.items;
}

export function createGroupConversation(
  client: AgentApiClient,
  input: {
    title?: string | null;
    solution_instance_id?: string | null;
    /** Required only for free groups; solution groups are server-owned. */
    coordinator_employee_id?: string;
  },
): Promise<Conversation | null> {
  return createConversation(client, {
    title: input.title,
    kind: "group",
    collaboration_mode: input.solution_instance_id ? "orchestrated" : "free",
    ...(input.coordinator_employee_id ? { coordinator_employee_id: input.coordinator_employee_id } : {}),
    solution_instance_id: input.solution_instance_id,
  });
}
