/** 本地私聊工作区：保持会话、时间线与 message → run 行为，视图直接使用 Astryx。 */
import { useCallback, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import { useApiError, useApp } from "../../lib/app-context";
import { ConversationStateControl } from "./ConversationStateControl";
import { ConversationList } from "./ConversationList";
import { TimelineView } from "./TimelineView";
import { MessageComposer } from "./MessageComposer";
import { LoopPanel, RunsPanel } from "../runs";
import { TerminalPanel } from "../terminal";
import { RosterPicker } from "./RosterPicker";
import type { Conversation } from "./useChatApi";
import { createConversation } from "./useChatApi";
import type { LoadedExpertProjection } from "../group/useGroupApi";

export function ChatPage(): React.ReactNode {
  const { client } = useApp();
  const toMessage = useApiError();
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [sentSignal, setSentSignal] = useState(0);
  const [loopPanelOpen, setLoopPanelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleSelect = useCallback((conversation: Conversation) => setSelected(conversation), []);
  const handleSent = useCallback(() => setSentSignal((signal) => signal + 1), []);
  const handleCancelCreate = useCallback(() => {
    if (creating) return;
    setCreateOpen(false);
    setCreateError(null);
  }, [creating]);

  const handlePick = useCallback(async (expert: LoadedExpertProjection) => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createConversation(client, {
        title: expert.display_name,
        collaboration_mode: "free",
        entry_employee_id: expert.employee_id,
      });
      if (!created) {
        setCreateError(toMessage(new Error("建会话返回为空")));
        return;
      }
      setSelected(created);
      setSentSignal((signal) => signal + 1);
      setCreateOpen(false);
    } catch (err) {
      setCreateError(toMessage(err));
    } finally {
      setCreating(false);
    }
  }, [client, creating, toMessage]);

  return (
    <HStack gap={4} align="start">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={sentSignal}
        onCreate={() => setCreateOpen(true)}
      />
      <Card role="region" aria-label="会话工作区">
        {selected ? (
          <VStack gap={4}>
            <ConversationStateControl client={client} conversation={selected} onStateChanged={setSelected} />
            <HStack justify="between" align="center">
              <Heading level={2}>{selected.title ?? selected.id}</Heading>
              <Button
                label="任务编排"
                variant={loopPanelOpen ? "secondary" : "ghost"}
                aria-pressed={loopPanelOpen}
                onClick={() => setLoopPanelOpen((open) => !open)}
              />
            </HStack>
            {loopPanelOpen ? <LoopPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} /> : null}
            <ChatLayout
              density="balanced"
              composer={<MessageComposer conversationId={selected.id} onSent={handleSent} />}
              emptyState={<Text>选择一个会话开始对话</Text>}
            >
              <TimelineView client={client} conversationId={selected.id} refreshSignal={sentSignal} />
            </ChatLayout>
            <RunsPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} />
            <TerminalPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} />
          </VStack>
        ) : <EmptyState title="选择一个会话开始对话" actions={<Button label="新建对话" variant="primary" onClick={() => setCreateOpen(true)} />} />}
      </Card>
      {createOpen ? <RosterPicker client={client} onPick={handlePick} onCancel={handleCancelCreate} busy={creating} error={createError} /> : null}
    </HStack>
  );
}
