/**
 * W-A.2 时间线视图（右侧）—— 渲染 BusinessTimelineEvent 流（08 §12.2 / D6）。
 *
 * 复用 @aiteam/shared 的 TimelineStore（cursor 单调升序 + 去重 + loadOlder 翻旧页），
 * history fetcher 由 useChatApi.createTimelineFetcher 适配本端 AgentApiClient。
 *
 * 红线（D6）：**只消费 BusinessTimelineEvent**，绝不绑 runtime-native event。
 * 本组件不解析 payload 形状（各 type 由后端定稿），仅按 type + created_at 渲染骨架。
 */

import { useEffect, useMemo, useState } from "react";
import type { BusinessTimelineEvent } from "@aiteam/shared/contracts";
import { TimelineStore } from "@aiteam/shared/timeline-client";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";

import type { AgentApiClient } from "../../lib/api-client";
import { createTimelineFetcher } from "./useChatApi";

export interface TimelineViewProps {
  client: AgentApiClient;
  conversationId: string;
  /** 新消息发送后 +1 触发 catchUp 补洞（重拉 since highWater 的新事件）。 */
  refreshSignal?: number;
}

export function TimelineView({ client, conversationId, refreshSignal = 0 }: TimelineViewProps) {
  const store = useMemo(
    () => new TimelineStore({ conversationId, history: createTimelineFetcher(client) }),
    [client, conversationId],
  );

  const [events, setEvents] = useState<readonly BusinessTimelineEvent[]>(() => store.snapshot);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    const unsub = store.onChange((next) => setEvents([...next]));
    // 初始：从最新一页向后回填（after=null 取全量；TimelineStore 的 catchUp 走 afterCursor=highWater）。
    void store.catchUp();
    return () => {
      unsub();
      store.stop();
    };
  }, [store]);

  // 发消息后触发 catchUp：补拉 since highWater 的新事件。
  useEffect(() => {
    if (refreshSignal === 0) return;
    void store.catchUp();
  }, [refreshSignal, store]);

  const handleLoadOlder = async (): Promise<void> => {
    if (loadingOlder || !store.canLoadMore) return;
    setLoadingOlder(true);
    try {
      await store.loadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <ChatMessageList
      ref={(node) => {
        node?.setAttribute("aria-label", "对话时间线");
      }}
      aria-label="对话时间线"
      data-testid="conversation-timeline"
      emptyState={<EmptyState title="暂无事件" isCompact />}
      scrollToTopAction={store.canLoadMore ? handleLoadOlder : undefined}
    >
      {events.map((event) => (
        <ChatMessage key={event.cursor} sender="assistant" name={event.type}>
          <ChatMessageBubble
            metadata={event.created_at}
            variant="ghost"
          >
            {renderPayload(event)}
          </ChatMessageBubble>
        </ChatMessage>
      ))}
    </ChatMessageList>
  );
}

/**
 * payload 渲染：最小必要——text/answer/answer_delta 等常见 type 取 text 字段，其余打印 JSON。
 * 具体 payload 形状由各端 OpenAPI 定稿（BusinessTimelineEvent 是最小稳定骨架）。
 */
function renderPayload(event: BusinessTimelineEvent): React.ReactNode {
  const text = typeof event.payload.text === "string" ? event.payload.text : null;
  if (text) return text;
  if (event.payload.content && typeof event.payload.content === "string") return event.payload.content;
  return JSON.stringify(event.payload);
}
