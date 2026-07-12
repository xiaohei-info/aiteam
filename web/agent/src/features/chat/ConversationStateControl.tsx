/** 会话持久主状态控制；展示态不落库，归档必须显式确认。 */
import { useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import type { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { setConversationState } from "./useChatApi";

type Transition = { to: string; label: string };

const TRANSITIONS: Record<string, Transition[]> = {
  draft: [{ to: "active", label: "激活" }],
  active: [{ to: "paused", label: "暂停" }, { to: "muted", label: "静音" }, { to: "archived", label: "归档" }],
  paused: [{ to: "active", label: "恢复" }, { to: "archived", label: "归档" }],
  muted: [{ to: "active", label: "取消静音" }, { to: "archived", label: "归档" }],
  archived: [],
};

const STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  active: "活跃",
  paused: "已暂停",
  muted: "已静音",
  archived: "已归档",
};

function stateVariant(state: string): BadgeVariant {
  if (state === "active") return "success";
  if (state === "archived") return "neutral";
  return "warning";
}

export interface ConversationStateControlProps {
  client: AgentApiClient;
  conversation: Conversation;
  onStateChanged: (conversation: Conversation) => void;
}

export function ConversationStateControl({ client, conversation, onStateChanged }: ConversationStateControlProps): React.ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState(false);
  const transitions = TRANSITIONS[conversation.state] ?? [];
  const stateLabel = STATE_LABELS[conversation.state] ?? conversation.state;

  async function handleTransition(to: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await setConversationState(client, conversation.id, to);
      if (updated) onStateChanged(updated);
      setPendingArchive(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "状态变更失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card role="region" aria-label="会话状态">
        <VStack gap={3}>
          <HStack justify="between" align="center">
            <Heading level={2}>会话状态</Heading>
            <Badge label={stateLabel} variant={stateVariant(conversation.state)} data-testid="conv-state-label" />
          </HStack>
          {transitions.length > 0 ? (
            <HStack gap={2} wrap="wrap">
              {transitions.map((transition) => (
                <Button
                  key={transition.to}
                  label={transition.label}
                  variant={transition.to === "archived" ? "destructive" : "ghost"}
                  size="sm"
                  isDisabled={busy}
                  onClick={() => {
                    if (transition.to === "archived") setPendingArchive(true);
                    else void handleTransition(transition.to);
                  }}
                />
              ))}
            </HStack>
          ) : <Text type="supporting">终态，无可执行操作</Text>}
          {error ? <Banner status="error" title={error} /> : null}
        </VStack>
      </Card>
      <AlertDialog
        isOpen={pendingArchive}
        onOpenChange={(open) => { if (!open && !busy) setPendingArchive(false); }}
        title="归档会话"
        description={`归档后会话「${conversation.title ?? conversation.id}」将不可恢复为活跃状态。`}
        cancelLabel="取消"
        actionLabel="确认归档"
        actionVariant="destructive"
        isActionLoading={busy}
        onAction={() => void handleTransition("archived")}
      />
    </>
  );
}
