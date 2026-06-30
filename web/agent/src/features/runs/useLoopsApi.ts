/**
 * W-A.2 Loop/任务编排 API 适配层（#312）。
 *
 * 对接 server/agent_service/loop/routes.py 北向端点：CRUD + enable/disable + fire。
 * 不重定义契约——Loop 模型字段对齐 server Loop；本文件只把 AgentApiClient 通用
 * 方法收口到本卡用到的端点。
 *
 * 红线（D3）：AgentApiClient 已在基类层拦截跨端直调，本文件无需重复校验。
 */

import type { AgentApiClient } from "../../lib/api-client";

export interface Loop {
  id: string;
  conversation_id: string;
  cron: string;
  title: string | null;
  status: "enabled" | "disabled";
  fire_count: number;
  last_run_id: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateLoopInput {
  conversation_id: string;
  cron: string;
  title?: string | null;
  enabled?: boolean;
}

export interface FireNowResult {
  loop_id: string;
  run_id: string | null;
  ok: boolean;
  error: string | null;
}

export async function listLoops(client: AgentApiClient): Promise<Loop[]> {
  return (await client.listGet<Loop>("/api/agent/loops")).items;
}

export async function createLoop(client: AgentApiClient, input: CreateLoopInput): Promise<Loop> {
  const result = await client.post<Loop>("/api/agent/loops", {
    body: {
      conversation_id: input.conversation_id,
      cron: input.cron,
      title: input.title ?? null,
      enabled: input.enabled ?? false,
    },
  });
  if (result === null) throw new Error("createLoop: empty envelope");
  return result;
}

export async function enableLoop(client: AgentApiClient, loopId: string): Promise<Loop> {
  const result = await client.post<Loop>(`/api/agent/loops/${encodeURIComponent(loopId)}/enable`, {});
  if (result === null) throw new Error("enableLoop: empty envelope");
  return result;
}

export async function disableLoop(client: AgentApiClient, loopId: string): Promise<Loop> {
  const result = await client.post<Loop>(`/api/agent/loops/${encodeURIComponent(loopId)}/disable`, {});
  if (result === null) throw new Error("disableLoop: empty envelope");
  return result;
}

export async function fireLoopNow(client: AgentApiClient, loopId: string): Promise<FireNowResult> {
  const result = await client.post<FireNowResult>(`/api/agent/loops/${encodeURIComponent(loopId)}/fire`, {});
  if (result === null) throw new Error("fireLoopNow: empty envelope");
  return result;
}
