/** 私聊员工/群聊共用的本地导航列表。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DigitalEmployeeAvatar } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
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
  groupByEmployee?: boolean;
  groupByGroup?: boolean;
  onItemsLoaded?: (conversations: Conversation[]) => void;
  onCreate?: () => void;
  createLabel?: string;
}

interface NavigationItem {
  key: string;
  conversation: Conversation;
  count: number;
}

function conversationGroupKey(conversation: Conversation, mode: "employee" | "group"): string {
  if (mode === "employee") return conversation.entry_employee_id ?? conversation.id;
  return conversation.solution_instance_id ?? conversation.coordinator_employee_id ?? conversation.title ?? conversation.id;
}

export function ConversationList({
  client,
  selectedId,
  onSelect,
  refreshSignal = 0,
  headerLabel = "私聊",
  filter,
  groupByEmployee = false,
  groupByGroup = false,
  onItemsLoaded,
  onCreate,
  createLabel = `新建${headerLabel}`,
}: ConversationListProps): React.ReactNode {
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const conversations: Conversation[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await listConversations(client, cursor, 100);
        conversations.push(...result.items);
        cursor = result.hasMore ? result.nextCursor : null;
        if (cursor && cursors.has(cursor)) throw new Error("conversation list: repeated cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const visible = filter ? conversations.filter(filter) : conversations;
      setItems(visible);
      onItemsLoaded?.(visible);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载会话失败");
    } finally {
      setLoading(false);
    }
  }, [client, filter, onItemsLoaded]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const navigationItems = useMemo<NavigationItem[]>(() => {
    const groupMode = groupByEmployee ? "employee" : groupByGroup ? "group" : null;
    if (!groupMode) return items.map((conversation) => ({ key: conversation.id, conversation, count: 1 }));
    const grouped = new Map<string, NavigationItem>();
    for (const conversation of items) {
      const key = conversationGroupKey(conversation, groupMode);
      const current = grouped.get(key);
      if (current) current.count += 1;
      else grouped.set(key, { key, conversation, count: 1 });
    }
    return [...grouped.values()];
  }, [groupByEmployee, groupByGroup, items]);

  const selectedGroupKey = (groupByEmployee || groupByGroup)
    ? (() => {
        const selected = items.find((conversation) => conversation.id === selectedId);
        return selected ? conversationGroupKey(selected, groupByEmployee ? "employee" : "group") : null;
      })()
    : null;

  return (
    <Card role="region" aria-label={`${headerLabel}列表`} width={280} padding={0}>
      <VStack gap={2} padding={3}>
        <HStack justify="between" align="center">
          <Heading level={3} data-testid="conv-list-header-label">{headerLabel}</Heading>
          {onCreate ? (
            <Button
              label={createLabel}
              icon={<span aria-hidden="true">＋</span>}
              isIconOnly
              tooltip={createLabel}
              variant="ghost"
              size="sm"
              onClick={onCreate}
            />
          ) : null}
        </HStack>
        {loading && items.length === 0 ? <Text role="status" type="supporting">加载中…</Text> : null}
        {error ? <Banner status="error" title={error} /> : null}
        {!loading && !error && navigationItems.length === 0 ? <EmptyState title={`暂无${headerLabel}`} isCompact /> : null}
        {navigationItems.length > 0 ? (
          <List aria-label={`${headerLabel}列表`} density="balanced">
            {navigationItems.map(({ key, conversation, count }) => {
              const selected = groupByEmployee || groupByGroup
                ? key === selectedGroupKey
                : conversation.id === selectedId;
              const title = conversation.title ?? conversation.id;
              const grouped = groupByEmployee || groupByGroup;
              const avatarSeed = conversation.entry_employee_id ?? conversation.coordinator_employee_id ?? key;
              return (
                <ListItem
                  key={key}
                  label={title}
                  description={groupByEmployee ? "数字员工" : "群聊"}
                  startContent={<DigitalEmployeeAvatar name={title} seed={avatarSeed} size={32} />}
                  endContent={grouped
                    ? (count > 1 ? <Badge label={`${count} 个对话`} variant="neutral" /> : undefined)
                    : <Badge label={conversation.state} variant={selected ? "info" : "neutral"} />}
                  isSelected={selected}
                  data-testid={`conversation-${conversation.id}`}
                  onClick={() => onSelect(conversation)}
                />
              );
            })}
          </List>
        ) : null}
      </VStack>
    </Card>
  );
}
