import type { AgentApiClient } from "../../lib/api-client";

export interface Run {
  id: string; conversation_id: string; status: string;
  session_id?: string | null; error?: string | null;
  usage?: Record<string, unknown> | null; created_at: string; updated_at: string;
}
export interface Task {
  id: string; conversation_id: string; run_id?: string | null;
  title: string; status: string; created_at: string; updated_at: string;
}

export async function listRuns(client: AgentApiClient, conversationId: string): Promise<Run[]> {
  return (await client.listGet<Run>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/runs`)).items;
}
export async function listTasks(client: AgentApiClient, conversationId: string): Promise<Task[]> {
  return (await client.listGet<Task>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/tasks`)).items;
}
export async function cancelRun(client: AgentApiClient, runId: string): Promise<void> {
  await client.post(`/api/agent/runs/${encodeURIComponent(runId)}/cancel`, {});
}

export async function retryRun(client: AgentApiClient, runId: string): Promise<Run | null> {
  return client.post<Run>(`/api/agent/runs/${encodeURIComponent(runId)}/retry`);
}
