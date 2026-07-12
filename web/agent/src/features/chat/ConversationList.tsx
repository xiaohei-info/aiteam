/** 私聊/群聊共用的本地会话列表；行为由 useChatApi 保持，视图直接使用 Astryx。 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import type { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { listConversations } from "./useChatApi";

export interface ConversationListProps {
  client: AgentApiClient;
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  refreshSignal?: number;
  headerLabel?: string;
  filter?: (conversation: Conversation) => boolean;
  onCreate?: () => void;
}

export function ConversationList({
  client,
  selectedId,
  onSelect,
  refreshSignal = 0,
  headerLabel = "私聊",
  filter,
  onCreate,
}: ConversationListProps): React.ReactNode {
  const [items, setItems] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleItems = useCallback(
    (conversations: Conversation[]) => (filter ? conversations.filter(filter) : conversations),
    [filter],
  );

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listConversations(client);
      setItems(visibleItems(result.items));
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载会话失败");
    } finally {
      setLoading(false);
    }
  }, [client, visibleItems]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, refreshSignal]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listConversations(client, nextCursor);
      setItems((previous) => [...previous, ...visibleItems(result.items)]);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载会话失败");
    } finally {
      setLoading(false);
    }
  }, [client, hasMore, loading, nextCursor, visibleItems]);

  return (
    <Card role="region" aria-label={`${headerLabel}会话`} width={280}>
      <VStack gap={3}>
        <HStack justify="between" align="center">
          <Heading level={2} data-testid="conv-list-header-label">{headerLabel}</Heading>
          {onCreate ? (
            <Button label={`新建${headerLabel}会话`} variant="primary" size="sm" onClick={onCreate} />
          ) : null}
        </HStack>
        {loading && items.length === 0 ? <Text role="status" type="supporting">加载中…</Text> : null}
        {error ? <Banner status="error" title={error} /> : null}
        {!loading && !error && items.length === 0 ? <EmptyState title={`暂无${headerLabel}会话`} isCompact /> : null}
        {items.length > 0 ? (
          <ul aria-label="会话列表">
            {items.map((conversation) => {
              const selected = conversation.id === selectedId;
              const title = conversation.title ?? conversation.id;
              return (
                <li key={conversation.id}>
                  <HStack justify="between" align="center" gap={2}>
                    <Button
                      label={title}
                      variant={selected ? "secondary" : "ghost"}
                      aria-pressed={selected}
                      onClick={() => onSelect(conversation)}
                    />
                    <Badge label={conversation.state} variant={selected ? "info" : "neutral"} />
                  </HStack>
                </li>
              );
            })}
          </ul>
        ) : null}
        {hasMore ? (
          <Button
            label={loading ? "加载中…" : "加载更多"}
            variant="ghost"
            isDisabled={loading}
            onClick={() => void loadMore()}
          />
        ) : null}
      </VStack>
    </Card>
  );
}
