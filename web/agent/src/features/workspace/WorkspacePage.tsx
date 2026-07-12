/**
 * W-A.4 工作台页（08 §12.1）—— 本地总览入口。
 *
 * 两段全局总览：近期会话（跳转私聊）+ Loop 状态/调度（启停/立即触发）。
 * 展示态（loading/error）为组件局部运行态，不入持久化主状态（D6）。
 * 红线：本地会话/执行内容只在本机呈现，绝不上传控制面（D13）。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";

import { useApp } from "../../lib/app-context";
import {
  createLoop,
  disableLoop,
  enableLoop,
  fireLoop,
  listConversations,
  listLoops,
  type Conversation,
  type Loop,
} from "./useWorkspaceApi";

export function WorkspacePage() {
  const { client, i18n } = useApp();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, l] = await Promise.all([listConversations(client), listLoops(client)]);
      setConversations(c);
      setLoops(l);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error"));
    } finally {
      setLoading(false);
    }
  }, [client, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const runLoopAction = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.action_error"));
      }
    },
    [load, i18n],
  );

  const [showCreateLoop, setShowCreateLoop] = useState(false);
  const [newConvId, setNewConvId] = useState("");
  const [newCron, setNewCron] = useState("0 9 * * *");
  const [newTitle, setNewTitle] = useState("");

  const handleCreateLoop = useCallback(async () => {
    if (!newConvId.trim() || !newCron.trim()) return;
    try {
      await createLoop(client, {
        conversation_id: newConvId.trim(),
        cron: newCron.trim(),
        title: newTitle.trim() || undefined,
      });
      setShowCreateLoop(false);
      setNewConvId("");
      setNewCron("0 9 * * *");
      setNewTitle("");
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.action_error"));
    }
  }, [client, newConvId, newCron, newTitle, load, i18n]);

  const enabledCount = loops.filter((l) => l.status === "enabled").length;

  return (
    <VStack gap={6} role="region" aria-label="本地工作台">
      <HStack justify="between" align="center" wrap="wrap">
        <Heading level={1}>{i18n.t("agent.nav.workspace")}</Heading>
        <Button label={i18n.t("agent.workspace.create_loop")} size="sm" variant="primary" onClick={() => setShowCreateLoop(true)} />
      </HStack>
      <Text as="p" type="supporting">
        {i18n.t("agent.workspace.summary")}: {conversations.length} · Loop {loops.length}（
        {enabledCount} {i18n.t("agent.workspace.enabled")}）
      </Text>
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}
      {loading && <Banner status="info" title={i18n.t("agent.workspace.loading")} />}

      <Card padding={4}>
        <VStack gap={2}>
        <Heading level={2}>{i18n.t("agent.workspace.conversations_title")}</Heading>
        {conversations.length === 0 ? (
          <EmptyState title={i18n.t("agent.workspace.conversations_empty")} headingLevel={3} isCompact />
        ) : (
          <VStack as="ul" gap={1}>
            {conversations.map((c) => (
              <HStack
                as="li"
                key={c.id}
                data-testid="ws-conversation"
                gap={1}
                align="center"
              >
                <Link to="/chat">{c.title || c.id}</Link>
                <Badge label={c.state} />
              </HStack>
            ))}
          </VStack>
        )}
        </VStack>
      </Card>

      <Card padding={4}>
        <VStack gap={2}>
        <Heading level={2}>{i18n.t("agent.workspace.loops_title")}</Heading>
        {loops.length === 0 ? (
          <EmptyState title={i18n.t("agent.workspace.loops_empty")} headingLevel={3} isCompact />
        ) : (
          <VStack as="ul" gap={2}>
            {loops.map((l) => (
              <HStack
                as="li"
                key={l.id}
                data-testid="ws-loop"
                gap={2}
                align="center"
                wrap="wrap"
              >
                <Text>{l.title || l.id}</Text>
                <Text type="code">{l.cron}</Text>
                <Badge label={l.status} variant={l.status === "enabled" ? "success" : "neutral"} />
                {l.status === "enabled" ? (
                  <Button
                    label={i18n.t("agent.workspace.disable")}
                    variant="secondary"
                    size="sm"
                    onClick={() => void runLoopAction(() => disableLoop(client, l.id))}
                  />
                ) : (
                  <Button
                    label={i18n.t("agent.workspace.enable")}
                    variant="secondary"
                    size="sm"
                    onClick={() => void runLoopAction(() => enableLoop(client, l.id))}
                  />
                )}
                <Button
                  label={i18n.t("agent.workspace.fire")}
                  size="sm"
                  variant="primary"
                  onClick={() => void runLoopAction(() => fireLoop(client, l.id))}
                />
              </HStack>
            ))}
          </VStack>
        )}
        </VStack>
      </Card>

      <Dialog
        isOpen={showCreateLoop}
        onOpenChange={setShowCreateLoop}
        purpose="form"
        aria-label={i18n.t("agent.workspace.create_loop_title")}
      >
        <VStack gap={3}>
          <Heading level={2}>{i18n.t("agent.workspace.create_loop_title")}</Heading>
          <TextInput label="会话 ID (conversation_id)" value={newConvId} onChange={setNewConvId} />
          <TextInput label="Cron 表达式" value={newCron} onChange={setNewCron} />
          <TextInput label={i18n.t("agent.workspace.title_optional")} value={newTitle} onChange={setNewTitle} />
          <HStack justify="end" gap={2}>
            <Button label={i18n.t("agent.workspace.cancel")} variant="secondary" onClick={() => setShowCreateLoop(false)} />
            <Button label={i18n.t("agent.workspace.create")} variant="primary" onClick={() => void handleCreateLoop()} />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}
