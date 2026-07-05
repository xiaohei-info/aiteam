/**
 * W-A.2 对话列表（左侧）—— 私聊会话列表 + cursor 翻页（08 §12.2 / 02 §10.3.7）。
 *
 * 黑金玻璃质感；复用本端 useChatApi.listConversations。选中后回调父组件切换右侧 timeline。
 * 不做展示态持久化（D6）——列表只读 Conversation（主状态枚举），不读展示态。
 */

import { useCallback, useEffect, useState } from "react";
import { GlassPanel, cn } from "@aiteam/shared/ui";

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
  /** 列表头部文案（默认"私聊"，群聊页传"群聊"复用同一组件）。 */
  headerLabel?: string;
  /** 可选过滤谓词（群聊页用于排除私聊会话）。 */
  filter?: (conversation: Conversation) => boolean;
}

export function ConversationList({
  client,
  selectedId,
  onSelect,
  refreshSignal = 0,
  headerLabel = "私聊",
  filter,
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
      setItems(filter ? result.items.filter(filter) : result.items);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [client, filter]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, refreshSignal]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listConversations(client, nextCursor);
      const merged = filter ? result.items.filter(filter) : result.items;
      setItems((prev) => [...prev, ...merged]);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [client, hasMore, nextCursor, loading]);

  return (
    <GlassPanel
      role="list"
      aria-label="会话列表"
      className="flex w-70 shrink-0 flex-col overflow-hidden rounded-window"
    >
      <div
        data-testid="conv-list-header"
        className="border-b border-gold/15 px-md py-sm text-sm font-semibold text-text-primary"
      >
        {headerLabel}
      </div>
      {loading && items.length === 0 && (
        <div className="px-md py-sm text-sm text-text-secondary">加载中…</div>
      )}
      {error && <div className="px-md py-sm text-sm text-danger">{error}</div>}
      <ul className="flex-1 list-none overflow-auto p-0">
        {items.map((conv) => {
          const active = conv.id === selectedId;
          return (
            <li key={conv.id} role="listitem" className="border-b border-gold/10">
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col gap-xs px-md py-sm text-left transition",
                  active
                    ? "border-l-2 border-gold bg-surface-raised"
                    : "hover:bg-surface-raised/60",
                )}
                aria-pressed={active}
                onClick={() => onSelect(conv)}
              >
                <span className="truncate text-sm text-text-primary">{conv.title ?? conv.id}</span>
                <span className="text-xs text-text-muted">{conv.state}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="border-t border-gold/15 bg-surface-raised/40 py-sm text-xs text-text-secondary disabled:opacity-60"
          onClick={() => void loadMore()}
          disabled={loading}
        >
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}
    </GlassPanel>
  );
}
