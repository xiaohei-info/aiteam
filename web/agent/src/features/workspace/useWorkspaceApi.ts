/**
 * W-A.4 工作台 —— API 适配层（08 §12.2 / 02 §10.3）。
 *
 * 本地总览只消费全局可列端点：会话（/api/agent/conversations）+ Loop（/api/agent/loops）。
 * run/task 为会话维度（仅 /conversations/{id}/runs|tasks，无全局列表），故在会话详情（私聊页）
 * 内呈现；工作台聚焦"近期会话 + Loop 状态/调度"两类全局总览与跳转。
 *
 * 红线：只调本端 /api/agent/*（基类 assertOwnTierPath 拦截跨端）；本地执行内容绝不上传（D13）。
 */
import type { AgentApiClient } from "../../lib/api-client";

/** 本地会话（对齐 server mainline Conversation，仅取总览所需字段）。 */
export interface Conversation {
  id: string;
  title: string | null;
  state: string;
  updated_at: string;
}

/** Loop（对齐 server agent_service/loop/models.py:Loop）。status 为持久化主状态 enabled|disabled。 */
export interface Loop {
  id: string;
  conversation_id: string;
  cron: string;
  title: string | null;
  status: string;
  last_run_id: string | null;
}

export async function listConversations(client: AgentApiClient): Promise<Conversation[]> {
  // 边界保证数组不变量：即使后端返回 data:null 也归一为 []，组件无需到处判空。
  return (await client.listGet<Conversation>("/api/agent/conversations")).items ?? [];
}

export async function listLoops(client: AgentApiClient): Promise<Loop[]> {
  return (await client.listGet<Loop>("/api/agent/loops")).items ?? [];
}

export async function enableLoop(client: AgentApiClient, loopId: string): Promise<Loop | null> {
  return client.post<Loop>(`/api/agent/loops/${encodeURIComponent(loopId)}/enable`);
}

export async function disableLoop(client: AgentApiClient, loopId: string): Promise<Loop | null> {
  return client.post<Loop>(`/api/agent/loops/${encodeURIComponent(loopId)}/disable`);
}

export async function fireLoop(client: AgentApiClient, loopId: string): Promise<unknown> {
  return client.post(`/api/agent/loops/${encodeURIComponent(loopId)}/fire`);
}

export interface CreateLoopInput {
  conversation_id: string;
  cron: string;
  title?: string;
}

export async function createLoop(client: AgentApiClient, input: CreateLoopInput): Promise<Loop | null> {
  return client.post<Loop>("/api/agent/loops", { body: input });
}
