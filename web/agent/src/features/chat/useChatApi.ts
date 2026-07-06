/**
 * W-A.2 私聊对话页（#67）—— API 适配层（08 §12.2 / 02 §10.3）。
 *
 * 好品味点：不重定义契约——Conversation / Message / BusinessTimelineEvent 一律来自
 * @aiteam/shared。本文件只把 AgentApiClient 的通用 listGet / get / post 收口到本卡用到的
 * 几个端点（列会话 / 取时间线 / 发消息），并暴露一个 TimelineHistoryFetcher 适配器，
 * 让 shared 的 TimelineStore 直接消费归一后的业务时间线（D6）。
 *
 * 红线（D6）：只消费 BusinessTimelineEvent，绝不绑定 runtime-native event。
 * 红线（D3）：AgentApiClient 已在基类层拦截跨端直调，本文件无需重复校验。
 */

import type { BusinessTimelineEvent } from "@aiteam/shared/contracts";
import type { TimelineHistoryFetcher } from "@aiteam/shared/timeline-client";

import type { AgentApiClient } from "../../lib/api-client";

/**
 * 本地会话（对齐 server agent_service/mainline/models.py:Conversation）。
 * 主状态固定枚举 ConversationState；**无展示态字段**（D6）——展示态不入持久化主状态。
 */
export interface Conversation {
  id: string;
  title: string | null;
  state: string;
  // 协作编排字段（parity 后端 Conversation）。
  collaboration_mode?: string;
  orchestration_brief?: string;
  planner_employee_id?: string | null;
  // 私聊归属员工 employee_id（parity 后端 Conversation.entry_employee_id）；群聊/编排会话为 null。
  entry_employee_id?: string | null;
  // 方案实例绑定（从 Operator 行业方案"创建群聊"入口固定编排时设置）；空=自由创建/私聊。
  solution_instance_id?: string | null;
  // 方案级固定编排三阶段 prompts 快照；空串=回退运行时默认。
  solution_planner_prompt?: string;
  solution_subtask_prompt?: string;
  solution_aggregate_prompt?: string;
  // 方案对应的专家群 employee_id 快照（固定编排 roster 过滤用）；自由创建/私聊为空列表。
  solution_expert_employee_ids?: string[];
  // AITEAM-236 阅读状态（parity 后端 Conversation.last_read_at / last_read_message_id）。
  last_read_at: string | null;
  last_read_message_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 消息发出方（对齐 server MessageRole）。 */
export type MessageRole = "user" | "employee" | "system";

/** 会话内一条消息（对齐 server Message；本地落库，绝不上传）。 */
export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

/** 发消息入参（对齐 server CreateMessageRequest，role 默认 user）。 */
export interface SendMessageInput {
  content: string;
  role?: MessageRole;
}

/**
 * 列会话。后端当前不带 cursor，但本卡要求"列表 cursor 翻页"——为不破坏后端契约，
 * 这里把 cursor 透传到 query（后端不识别时忽略），未来后端加 cursor 字段无需改前端。
 */
export async function listConversations(
  client: AgentApiClient,
  cursor?: string | null,
): Promise<{ items: Conversation[]; nextCursor: string | null; hasMore: boolean }> {
  const result = await client.listGet<Conversation>("/api/agent/conversations", {
    query: cursor ? { cursor } : undefined,
  });
  return { items: result.items, nextCursor: result.page.next_cursor, hasMore: result.page.has_more };
}

/** 建会话入参（对齐 server routes.py:CreateConversationRequest）。 */
export interface CreateConversationInput {
  /** 会话标题（可选；未给则自动生成）。 */
  title?: string | null;
  /** 协作模式：free（私聊默认）| orchestrated（规则编排，群聊可选）。 */
  collaboration_mode?: "free" | "orchestrated" | null;
  /** 私聊归属员工 employee_id（对齐 server models.py:Conversation.entry_employee_id）。 */
  entry_employee_id?: string | null;
}

/**
 * 建会话（POST /api/agent/conversations）。
 * 私聊页传 entry_employee_id 把会话绑定到招募到的专家；群聊页可不传。
 */
export async function createConversation(
  client: AgentApiClient,
  input: CreateConversationInput,
): Promise<Conversation | null> {
  return client.post<Conversation>("/api/agent/conversations", {
    body: {
      ...(input.title !== undefined && input.title !== null ? { title: input.title } : {}),
      ...(input.collaboration_mode ? { collaboration_mode: input.collaboration_mode } : {}),
      ...(input.entry_employee_id ? { entry_employee_id: input.entry_employee_id } : {}),
    },
  });
}

/**
 * 取时间线（cursor 增量拉取）。后端支持 `after`（返回 cursor>after 的事件）；
 * `before`（向前翻旧）后端当前未实现，传给 fetcher 时由本卡按 after 语义兜底——
 * TimelineStore 仍按 beforeCursor 调本函数，由本适配器统一映射成 after（取最新一页）。
 *
 * 返回 hasMore：after 分支恒为 false（后端一页返回所有新增），before 分支恒为 false
 * （后端无 before 语义，单页即当前已知全集）。这与"loadOlder 直到源说到底"契约一致。
 */
export async function getTimeline(
  client: AgentApiClient,
  conversationId: string,
  params: { before?: number | null; after?: number | null; limit?: number } = {},
): Promise<{ events: BusinessTimelineEvent[]; hasMore: boolean }> {
  // 后端只有 after；before 场景取 after=0（即当前所有已知事件），hasMore=false 表示到底。
  const after = params.after ?? 0;
  const result = await client.listGet<BusinessTimelineEvent>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/timeline`,
    { query: { after } },
  );
  // before 场景下，可能需要按 beforeCursor 过滤掉更新的事件，模拟"向前翻旧"语义。
  let events = result.items;
  if (params.before != null) {
    events = events.filter((e) => e.cursor < params.before!);
  }
  return { events, hasMore: result.page.has_more };
}

/** 发消息（POST /api/agent/conversations/{id}/messages）。 */
export async function sendMessage(
  client: AgentApiClient,
  conversationId: string,
  input: SendMessageInput,
): Promise<Message | null> {
  return client.post<Message>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`,
    { body: { content: input.content, role: input.role ?? "user" } },
  );
}

/**
 * 构造一个可直接喂给 TimelineStore 的 history fetcher。把 client 闭包进去，
 * 调用方只关心 conversationId + cursor 方向（消除"每次手搓 fetcher"的特殊情况）。
 */
export function createTimelineFetcher(client: AgentApiClient): TimelineHistoryFetcher {
  return async ({ conversationId, afterCursor, beforeCursor, limit }) =>
    getTimeline(client, conversationId, {
      after: afterCursor,
      before: beforeCursor,
      limit,
    });
}

/** Run 结果（对齐 server mainline/models.py:Run）。 */
export interface Run {
  id: string;
  conversation_id: string;
  status: string;
  session_id?: string | null;
  error?: string | null;
  usage?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * 起 run（POST /api/agent/conversations/{id}/runs）。
 * 发消息后调此接口触发 AI 处理，时间线会产出 BusinessTimelineEvent。
 */
export async function startRun(
  client: AgentApiClient,
  conversationId: string,
  taskId?: string | null,
): Promise<Run | null> {
  return client.post<Run>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/runs`,
    { body: taskId ? { task_id: taskId } : {} },
  );
}

/** 改会话主状态（对齐 PUT /api/agent/conversations/{id}/state）。 */
export async function setConversationState(
  client: AgentApiClient,
  conversationId: string,
  state: string,
): Promise<Conversation | null> {
  return client.put<Conversation>(
    `/api/agent/conversations/${encodeURIComponent(conversationId)}/state`,
    { body: { state } },
  );
}
