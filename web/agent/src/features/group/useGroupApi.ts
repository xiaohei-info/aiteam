/**
 * W-A.3 群聊编排 API 适配层（#68 / 06 §7.6 / D19）。
 *
 * 本文件只收口群聊独有的一个端点：POST /group-dispatch（@提及触发多专家协作）。
 * 契约类型按本端 API 边界镜像（shared 未镜像，与 AgentLoginRequest 同级处理）。
 * 群聊展示由 TimelineView 直接消费 Agent 事件流。
 * 红线（D3）：AgentApiClient 基类已拦截跨端直调，本文件无需重复校验。
 */

import type { AgentApiClient } from "../../lib/api-client";

/**
 * 本端可用的方案实例投影（对齐 server agent_service/grants/store.py:SolutionProjection）。
 * 供"从解决方案创建群聊"弹窗使用——含三阶段 prompts 快照（不可覆盖，固定编排语义）。
 */
export interface SolutionProjection {
  solution_instance_id: string;
  display_name: string;
  version: string;
  expert_employee_ids?: string[];
  planner_prompt: string;
  subtask_prompt: string;
  aggregate_prompt: string;
}

/**
 * 模型配置（对齐 server shared/contracts/snapshot.py:ModelPolicy）。
 * 供 roster 判断专家配置完整度：model 与 provider_ref 齐全才视为可私聊专家。
 */
export interface ModelPolicy {
  model?: string | null;
  provider_ref?: string | null;
  thinking_level?: string | null;
}

/**
 * 本地可用专家投影（对齐 server shared/contracts/grants.py:LoadedExpertProjection）。
 * 用于群聊 roster 数据源——替代演示用 mock。
 */
export interface LoadedExpertProjection {
  employee_id: string;
  tenant_id: string;
  version: string;
  /** Stable ASCII handle for roster/@提及. Prefer this over display_name for matching. */
  handle: string;
  display_name: string;
  runtime_binding?: string | null;
  synced_at?: string | null;
  revoked: boolean;
  /** 模型配置（model/provider_ref）。用于 roster 配置完整度防呆；缺失示"待 Manager 配置"。 */
  model_policy?: ModelPolicy | null;
}

/**
 * 群聊里的一个专家（对齐 server group.py:GroupExpert）。
 * handle 是 @提及里用的标识；persona/model 为派生 RunSpec 所需最小字段。
 */
export interface GroupExpert {
  handle: string;
  /** Stable employee id; used for solution roster filtering (over display_name reverse lookup). */
  employee_id?: string;
  display_name?: string;
  system_prompt?: string | null;
  model?: string | null;
}

/** 一次 Run（对齐 server models.py:Run，持久终态；展示态不在此）。 */
export interface GroupRun {
  id: string;
  conversation_id: string;
  status: string;
  session_id?: string | null;
  error?: string | null;
  usage?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** 一轮群聊编排结果（对齐 server group.py:DispatchResult）。 */
export interface DispatchResult {
  triggered_handles: string[];
  runs: GroupRun[];
  /** 本轮 input 中未被 roster 命中的 @提及（带 @ 前缀，保序）。前端据此给出负向提示。服务端可选字段。 */
  ignored_handles?: string[];
}

/** 群聊编排入参（对齐 server routes.py:GroupDispatchRequest）。 */
export interface GroupDispatchInput {
  /** 用户发言原文（含 @提及）。后端字段名为 text。 */
  text: string;
  /** 本会话已装载专家 roster（演示用，由前端持有；后端按请求体携带编排）。 */
  experts: GroupExpert[];
}

/**
 * 列本会话已装载/已授权专家（GET /api/agent/grants/experts）。
 * 群聊 roster 真实数据源（替演示用 mock）。
 */
export async function listLoadedExperts(
  client: AgentApiClient,
): Promise<LoadedExpertProjection[]> {
  const result = await client.listGet<LoadedExpertProjection>("/api/agent/grants/experts");
  return result.items;
}

/** 授权同步结果（对齐 server SyncResultBody）。 */
export interface SyncGrantsResult {
  ok: boolean;
  upserted: number;
  revoked: number;
  error?: string | null;
}

/**
 * 触发本端授权配置同步（POST /api/agent/grants/sync）。
 * 用于 roster 打开时主动 pull，便于前端在 Manager 不可达/未授权时给出 Manager 端指向的错误提示。
 */
export async function syncGrants(
  client: AgentApiClient,
  input: { tenant_id: string; member_id: string },
): Promise<SyncGrantsResult> {
  const result = await client.post<SyncGrantsResult>("/api/agent/grants/sync", { body: input });
  if (result === null) {
    throw new Error("syncGrants: empty envelope");
  }
  return result;
}

/**
 * 群聊一轮编排：用户发言 -> 后端解析 @提及 -> 被 @ 的每个专家各起一个 run（并发）
 * -> 多 run 归一事件并入同一会话时间线（TimelineStore 按 cursor 归并，天然支持）。
 *
 * 调用方拿到 DispatchResult 后：展示 triggered_handles（"@提及触发了哪些专家"），
 * 并触发 TimelineView catchUp 补拉 since highWater 的新事件（由父组件 refreshSignal 驱动）。
 */
export async function groupDispatch(
  client: AgentApiClient,
  conversationId: string,
  input: GroupDispatchInput,
): Promise<DispatchResult> {
  const result = await client.post<DispatchResult>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/group-dispatch`,
    { body: { text: input.text, experts: input.experts } },
  );
  // 后端约定返回 envelope.data；防御性兜底（与 AgentApiClient.login 同模式）。
  if (result === null) {
    throw new Error("group-dispatch: empty envelope");
  }
  return result;
}

/**
 * 列出本端可用的方案实例投影（GET /api/agent/grants/solutions）。
 * 供"从解决方案创建群聊"弹窗选择列表。
 */
export async function listSolutionInstances(
  client: AgentApiClient,
): Promise<SolutionProjection[]> {
  const result = await client.listGet<SolutionProjection>("/api/agent/grants/solutions");
  return result.items;
}

/**
 * 从 Operator 行业方案创建群聊会话（固定编排）。
 * 后端返回 Conversation（collaboration_mode 自动为 orchestrated），后续群聊 stage 走方案自带的三阶段 prompts。
 */
export interface CreateFromSolutionInput {
  solution_instance_id: string;
  title?: string | null;
}

export async function createConversationFromSolution(
  client: AgentApiClient,
  input: CreateFromSolutionInput,
): Promise<import("../chat/useChatApi").Conversation> {
  const result = await client.post<import("../chat/useChatApi").Conversation>(
    "/api/agent/conversations",
    {
      body: {
        title: input.title ?? null,
        solution_instance_id: input.solution_instance_id,
      },
    },
  );
  if (result === null) {
    throw new Error("createConversationFromSolution: empty envelope");
  }
  return result;
}

/**
 * 创建自由群聊会话（自由协作——由 Planner/协调员决定协作方式；无固定编排规则）。
 * 不绑定 solution_instance_id；session 创建后用户可自由拉 Agent 进群。
 */
export async function createFreeConversation(
  client: AgentApiClient,
  input: { title?: string | null },
): Promise<import("../chat/useChatApi").Conversation> {
  const result = await client.post<import("../chat/useChatApi").Conversation>(
    "/api/agent/conversations",
    {
      body: {
        title: input.title ?? null,
      },
    },
  );
  if (result === null) {
    throw new Error("createFreeConversation: empty envelope");
  }
  return result;
}
