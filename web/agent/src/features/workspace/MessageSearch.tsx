import { useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Link, useNavigate } from "react-router-dom";
import type { AgentApiClient } from "../../lib/api-client";
import { getConversation, searchMessages, type MessageSearchHit } from "../chat/useChatApi";

export interface MessageSearchProps {
  client: AgentApiClient;
}

/** Local-only message search with server-owned cursor pagination and entry_ref links. */
export function MessageSearch({ client }: MessageSearchProps): ReactNode {
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [results, setResults] = useState<MessageSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function runSearch(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const value = query.trim();
    if (!value || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await searchMessages(client, { q: value, limit: 50 });
      setSearchedQuery(value);
      setResults(page.items);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "消息搜索失败");
      setResults([]);
      setNextCursor(null);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  async function openHit(event: MouseEvent<HTMLAnchorElement>, hit: MessageSearchHit): Promise<void> {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (opening) return;
    setOpening(hit.entry_ref);
    try {
      // Search deliberately returns only message fields. Resolve the existing
      // owner-scoped conversation projection before choosing chat vs group.
      const conversation = await getConversation(client, hit.conversation_id);
      navigate(conversationPath(conversation?.kind ?? hit.kind, hit));
    } catch {
      // Keep a search hit usable during a transient metadata read failure. An
      // additive server kind hint can still route groups; otherwise chat is the
      // safe legacy default and the target page remains owner-checked.
      navigate(conversationPath(hit.kind, hit));
    } finally {
      setOpening(null);
    }
  }

  async function loadMore(): Promise<void> {
    if (!searchedQuery || !nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await searchMessages(client, { q: searchedQuery, cursor: nextCursor, limit: 50 });
      setResults((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : "消息搜索失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card padding={4} data-testid="message-search" role="region" aria-label="本地消息搜索">
      <VStack gap={3}>
        <VStack gap={1}>
          <Text weight="semibold">搜索本地消息</Text>
          <Text type="supporting">只搜索本机 owner 会话中的可见消息，不上传正文。</Text>
        </VStack>
        <form onSubmit={(event) => void runSearch(event)}>
          <HStack gap={2} align="end">
            <TextInput
              label="搜索词"
              isLabelHidden
              placeholder="搜索消息…"
              value={query}
              onChange={setQuery}
              width="100%"
            />
            <Button type="submit" label="搜索" variant="secondary" isLoading={loading && results.length === 0} isDisabled={!query.trim() || loading} />
          </HStack>
        </form>
        {error ? <Banner status="error" title={error} data-testid="message-search-error" /> : null}
        {searchedQuery && !loading && results.length === 0 && !error ? <Text type="supporting" role="status">没有找到匹配消息</Text> : null}
        {results.length > 0 ? (
          <VStack as="ul" gap={2} data-testid="message-search-results">
            {results.map((hit) => (
              <li key={`${hit.entry_ref}-${hit.participant_employee_id ?? "session"}`}>
                <Link
                  to={conversationPath(hit.kind, hit)}
                  onClick={(event) => void openHit(event, hit)}
                  aria-busy={opening === hit.entry_ref}
                  data-testid={`message-search-hit-${hit.entry_ref}`}
                >
                  <VStack gap={1}>
                    <Text weight="semibold">{hit.conversation_title || "未命名会话"}</Text>
                    <Text type="supporting">{hit.source_employee_display_name || (hit.role === "user" ? "我" : "数字员工")} · {formatHitTime(hit.timestamp)}</Text>
                    <Text>{hit.snippet}</Text>
                  </VStack>
                </Link>
              </li>
            ))}
          </VStack>
        ) : null}
        {hasMore && nextCursor ? <Button label="加载更早结果" variant="ghost" onClick={() => void loadMore()} isLoading={loading} isDisabled={loading} /> : null}
      </VStack>
    </Card>
  );
}

function conversationPath(kind: string | null | undefined, hit: MessageSearchHit): string {
  const path = kind === "group" ? "/group" : "/chat";
  return `${path}?conversation_id=${encodeURIComponent(hit.conversation_id)}&entry_ref=${encodeURIComponent(hit.entry_ref)}`;
}

function formatHitTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
