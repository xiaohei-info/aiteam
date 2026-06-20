/**
 * W-A.2 对话列表（左侧）—— 私聊会话列表 + cursor 翻页（08 §12.2 / 02 §10.3.7）。
 *
 * 复用本端 useChatApi.listConversations。选中后回调父组件切换右侧 timeline。
 * 不做展示态持久化（D6）——列表只读 Conversation（主状态枚举），不读展示态。
 */

import { useCallback, useEffect, useState } from "react";

import type { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { listConversations } from "./useChatApi";

export interface ConversationListProps {
  client: AgentApiClient;
  /** 当前选中会话 id（null 表示未选中）。 */
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  /** 列表刷新信号（发送消息后可让父组件 +1 触发重载）。 */
  refreshSignal?: number;
}

export function ConversationList({
  client,
  selectedId,
  onSelect,
  refreshSignal = 0,
}: ConversationListProps) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listConversations(client);
      setItems(result.items);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, refreshSignal]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listConversations(client, nextCursor);
      setItems((prev) => [...prev, ...result.items]);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [client, hasMore, nextCursor, loading]);

  return (
    <div className="chat-list" role="list" aria-label="会话列表">
      <div className="chat-list__header">私聊</div>
      {loading && items.length === 0 && <div className="chat-list__loading">加载中…</div>}
      {error && <div className="chat-list__error">{error}</div>}
      <ul className="chat-list__items">
        {items.map((conv) => {
          const active = conv.id === selectedId;
          return (
            <li
              key={conv.id}
              role="listitem"
              className={`chat-list__item${active ? " chat-list__item--active" : ""}`}
            >
              <button
                type="button"
                className="chat-list__item-btn"
                aria-pressed={active}
                onClick={() => onSelect(conv)}
              >
                <span className="chat-list__item-title">{conv.title ?? conv.id}</span>
                <span className="chat-list__item-state">{conv.state}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="chat-list__more"
          onClick={() => void loadMore()}
          disabled={loading}
        >
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
    </div>
  );
}
