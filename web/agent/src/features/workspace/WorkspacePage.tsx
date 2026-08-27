/** Local workspace dashboard: local conversation overview and entry points. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { DigitalEmployeeAvatar } from "@aiteam/shared";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";
import { listConversations, type Conversation } from "./useWorkspaceApi";

const RECENT_CONVERSATION_LIMIT = 8;

function formatConversationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function conversationTitle(conversation: Conversation): string {
  return conversation.title || (conversation.kind === "group" ? "群聊" : "私聊");
}

function conversationType(conversation: Conversation): string {
  return conversation.kind === "group" ? "群聊" : "私聊";
}

function conversationRoute(conversation: Conversation): string {
  const path = conversation.kind === "group" ? "/group" : "/chat";
  return `${path}?conversation_id=${encodeURIComponent(conversation.id)}`;
}

function employeeIdForConversation(conversation: Conversation): string | null {
  return conversation.kind === "group"
    ? conversation.coordinator_employee_id
    : conversation.entry_employee_id;
}

function isActiveConversation(conversation: Conversation): boolean {
  return conversation.state === "active" || conversation.state === "draft";
}

export function WorkspacePage() {
  const { client, i18n } = useApp();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, roster] = await Promise.all([
        listConversations(client),
        listLoadedExperts(client).catch(() => []),
      ]);
      setConversations(items);
      setExperts(roster);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error"));
    } finally {
      setLoading(false);
    }
  }, [client, i18n]);

  useEffect(() => { void load(); }, [load]);

  const expertById = useMemo(
    () => new Map(experts.map((expert) => [expert.employee_id, expert] as const)),
    [experts],
  );
  const recentConversations = useMemo(
    () => [...conversations]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .slice(0, RECENT_CONVERSATION_LIMIT),
    [conversations],
  );
  const activeCount = conversations.filter(isActiveConversation).length;
  const groupCount = conversations.filter((conversation) => conversation.kind === "group").length;
  const scheduledCount = conversations.filter((conversation) => conversation.schedule !== null).length;

  return (
    <VStack gap={6} role="region" aria-label="本地工作台" data-testid="workspace-dashboard">
      <HStack justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{i18n.t("agent.nav.workspace")}</Heading>
          <Text as="p" type="supporting">本地会话、协作与执行状态总览；会话内容始终保存在本机。</Text>
        </VStack>
        <Button label="刷新" variant="secondary" isLoading={loading} onClick={() => void load()} />
      </HStack>

      {error ? <Banner status="error" title={error} /> : null}

      <HStack gap={3} wrap="wrap" data-testid="workspace-summary">
        {[
          ["总会话", conversations.length],
          ["进行中", activeCount],
          ["群聊", groupCount],
          ["已调度", scheduledCount],
        ].map(([label, value]) => (
          <Card key={label} padding={3} width={170}>
            <VStack gap={1}>
              <Text type="supporting">{label}</Text>
              <Heading level={2}>{value}</Heading>
            </VStack>
          </Card>
        ))}
      </HStack>

      <HStack gap={3} align="start" wrap="wrap">
        <Card padding={4} width={360} data-testid="workspace-quick-actions">
          <VStack gap={3}>
            <VStack gap={1}>
              <Heading level={2}>快速开始</Heading>
              <Text type="supporting">从本地会话进入执行，不需要先经过企业控制面。</Text>
            </VStack>
            <HStack gap={2} wrap="wrap">
              <Button label="开始私聊" variant="primary" onClick={() => navigate("/chat")} />
              <Button label="开始群聊" variant="secondary" onClick={() => navigate("/group")} />
            </HStack>
            <HStack gap={2} wrap="wrap">
              <Button label="查看办公室" variant="ghost" onClick={() => navigate("/office")} />
              <Button label="查看组织架构" variant="ghost" onClick={() => navigate("/org")} />
            </HStack>
          </VStack>
        </Card>
        <Card padding={4} width={360} data-testid="workspace-local-model">
          <VStack gap={2}>
            <Heading level={2}>本地执行面</Heading>
            <Text type="supporting">私聊和群聊由本机 Agent Session 执行，运行事件、附件和会话正文不会上传到 Manager。</Text>
            <Text type="supporting">需要持续运行的任务可在对应会话中配置调度；办公室页面用于查看员工状态与调度概览。</Text>
          </VStack>
        </Card>
      </HStack>

      <Card padding={4} data-testid="workspace-recent">
        <VStack gap={3}>
          <HStack justify="between" align="center">
            <VStack gap={1}>
              <Heading level={2}>{i18n.t("agent.workspace.conversations_title")}</Heading>
              <Text type="supporting">最近更新的本地会话</Text>
            </VStack>
            <Badge label={`${recentConversations.length}/${conversations.length}`} variant="neutral" />
          </HStack>
          {loading && conversations.length === 0 ? <Banner status="info" title={i18n.t("agent.workspace.loading")} /> : null}
          {!loading && recentConversations.length === 0 ? (
            <EmptyState title={i18n.t("agent.workspace.conversations_empty")} headingLevel={3} isCompact />
          ) : (
            <VStack as="ul" gap={2}>
              {recentConversations.map((conversation) => {
                const employee = employeeIdForConversation(conversation) ? expertById.get(employeeIdForConversation(conversation)!) : undefined;
                const title = conversationTitle(conversation);
                return (
                  <VStack as="li" key={conversation.id} gap={1} data-testid="ws-conversation">
                    <Link to={conversationRoute(conversation)}>
                      <HStack gap={2} align="center">
                        <DigitalEmployeeAvatar name={employee?.display_name ?? title} seed={employee?.employee_id ?? conversation.id} src={employee?.avatar_url} size={42} />
                        <VStack gap={0}>
                          <Text weight="semibold">{title}</Text>
                          <Text type="supporting">{conversationType(conversation)} · {formatConversationTime(conversation.updated_at)}</Text>
                        </VStack>
                        <Badge label={conversation.state} variant={isActiveConversation(conversation) ? "info" : "neutral"} />
                      </HStack>
                    </Link>
                  </VStack>
                );
              })}
            </VStack>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}
