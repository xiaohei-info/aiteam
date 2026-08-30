/** 本地私聊工作区：保持会话、Pi prompt/event 行为，视图直接使用 Astryx。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { ChatLayout } from "@astryxdesign/core/Chat";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { StackItem } from "@astryxdesign/core/Stack";

import { useApiError, useApp } from "../../lib/app-context";
import { ConversationStateControl } from "./ConversationStateControl";
import { ScheduleControl } from "./ScheduleControl";
import { ConversationList } from "./ConversationList";
import { TimelineView } from "./TimelineView";
import { MessageComposer } from "./MessageComposer";
import { ConversationContextHud } from "./ConversationContextHud";
import { FilesPanel } from "./FilesPanel";
import { RosterPicker } from "./RosterPicker";
import type { Conversation } from "./useChatApi";
import { createConversation } from "./useChatApi";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";

const isPrivateConversation = (conversation: Conversation) => conversation.kind !== "group" && conversation.entry_employee_id !== null;
const formatConversationTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
};

export function ChatPage(): React.ReactNode {
  const { client } = useApp();
  const toMessage = useApiError();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedConversationId = searchParams.get("conversation_id");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [sentSignal, setSentSignal] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);

  useEffect(() => {
    let alive = true;
    listLoadedExperts(client)
      .then((loaded) => { if (alive) setExperts(loaded); })
      .catch(() => { if (alive) setExperts([]); });
    return () => { alive = false; };
  }, [client]);

  const handleSelect = useCallback((conversation: Conversation) => {
    setPrompting(false);
    setScheduleOpen(false);
    setHistoryOpen(false);
    setCreateError(null);
    setSelected(conversation);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("conversation_id", conversation.id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const handleStateChanged = useCallback((conversation: Conversation) => setSelected(conversation), []);
  const handleScheduleChanged = useCallback((conversation: Conversation) => {
    setSelected(conversation);
    setSentSignal((signal) => signal + 1);
  }, []);
  const handleSent = useCallback(() => setSentSignal((signal) => signal + 1), []);
  useEffect(() => {
    if (!requestedConversationId || selected?.id === requestedConversationId) return;
    const target = conversations.find((conversation) => conversation.id === requestedConversationId);
    if (target) handleSelect(target);
  }, [conversations, handleSelect, requestedConversationId, selected?.id]);
  const handleCancelCreate = useCallback(() => {
    if (creating) return;
    setCreateOpen(false);
    setCreateError(null);
  }, [creating]);

  const createPrivateConversation = useCallback(async (employeeId: string, title: string) => {
    if (creating) return null;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createConversation(client, {
        title,
        collaboration_mode: "free",
        entry_employee_id: employeeId,
      });
      if (!created) throw new Error("建会话返回为空");
      handleSelect(created);
      setSentSignal((signal) => signal + 1);
      return created;
    } catch (err) {
      setCreateError(toMessage(err));
      return null;
    } finally {
      setCreating(false);
    }
  }, [client, creating, handleSelect, toMessage]);

  const handlePick = useCallback(async (expert: LoadedExpertProjection) => {
    const created = await createPrivateConversation(expert.employee_id, expert.display_name);
    if (created) setCreateOpen(false);
  }, [createPrivateConversation]);

  const history = useMemo(
    () => selected?.entry_employee_id
      ? conversations.filter((conversation) => conversation.entry_employee_id === selected.entry_employee_id)
      : [],
    [conversations, selected?.entry_employee_id],
  );
  const employeeName = history[0]?.title ?? selected?.title ?? "数字员工";

  const handleCreateForSelected = useCallback(() => {
    if (!selected?.entry_employee_id) return;
    void createPrivateConversation(selected.entry_employee_id, employeeName);
  }, [createPrivateConversation, employeeName, selected?.entry_employee_id]);

  return (
    <HStack data-testid="chat-layout" gap={4} align="start" width="100%">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={sentSignal}
        headerLabel="数字员工"
        filter={isPrivateConversation}
        groupByEmployee
        onItemsLoaded={setConversations}
        onCreate={() => setCreateOpen(true)}
        createLabel="开始新私聊"
      />
      <StackItem size="fill" crossAlignSelf="stretch">
        <Card role="region" aria-label="会话工作区" width="100%">
          {selected ? (
            <VStack gap={4} width="100%">
              <ConversationStateControl client={client} conversation={selected} onStateChanged={handleStateChanged} />
              <ConversationContextHud client={client} conversationId={selected.id} refreshSignal={sentSignal} isPrompting={prompting} />
              <HStack justify="between" align="center">
                <Heading level={2}>{employeeName}</Heading>
                <HStack gap={1} role="group" aria-label="对话操作">
                  <Button
                    label={`与${employeeName}新建对话`}
                    icon={<span aria-hidden="true">＋</span>}
                    isIconOnly
                    tooltip="新建对话"
                    variant="ghost"
                    size="sm"
                    isLoading={creating}
                    isDisabled={!selected.entry_employee_id}
                    onClick={handleCreateForSelected}
                  />
                  <Button
                    label="历史对话"
                    icon={<Icon icon="clock" size="sm" />}
                    isIconOnly
                    tooltip="历史对话"
                    variant="ghost"
                    size="sm"
                    onClick={() => setHistoryOpen(true)}
                  />
                  <Button
                    label={selected.schedule ? "查看调度设置" : "设置调度"}
                    icon={<Icon icon="calendar" size="sm" />}
                    isIconOnly
                    tooltip={selected.schedule ? "调度已设置" : "设置调度"}
                    variant="ghost"
                    size="sm"
                    onClick={() => setScheduleOpen(true)}
                  />
                </HStack>
              </HStack>
              {createError && !createOpen ? <Banner status="error" title={createError} /> : null}
              <ChatLayout
                density="balanced"
                composer={<MessageComposer conversationId={selected.id} conversation={selected} onConversationChanged={handleStateChanged} isPrompting={prompting} onPromptingChange={setPrompting} onSent={handleSent} />}
                emptyState={<Text>选择一个会话开始对话</Text>}
              >
                <TimelineView client={client} conversationId={selected.id} refreshSignal={sentSignal} onPromptingChange={setPrompting} sourceExperts={experts} />
              </ChatLayout>
            </VStack>
          ) : <EmptyState title="选择一个会话开始对话" actions={<Button label="新建对话" variant="primary" onClick={() => setCreateOpen(true)} />} />}
        </Card>
      </StackItem>
      {selected ? <FilesPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} /> : null}
      {selected && historyOpen ? (
        <Dialog
          isOpen
          purpose="info"
          width={560}
          maxHeight="80vh"
          aria-label="历史对话"
          onOpenChange={(open) => setHistoryOpen(open)}
        >
          <VStack gap={3}>
            <HStack justify="between" align="center">
              <Heading level={2}>历史对话</Heading>
              <Button
                label="关闭历史对话"
                icon={<Icon icon="close" size="sm" />}
                isIconOnly
                variant="ghost"
                size="sm"
                onClick={() => setHistoryOpen(false)}
              />
            </HStack>
            <List aria-label={`${employeeName}的历史对话`} density="balanced" hasDividers>
              {history.map((conversation) => (
                <ListItem
                  key={conversation.id}
                  label={conversation.title ?? employeeName}
                  description={formatConversationTime(conversation.updated_at)}
                  endContent={conversation.id === selected.id ? <Badge label="当前" variant="info" /> : undefined}
                  isSelected={conversation.id === selected.id}
                  data-testid={`history-${conversation.id}`}
                  onClick={() => handleSelect(conversation)}
                />
              ))}
            </List>
          </VStack>
        </Dialog>
      ) : null}
      {selected && scheduleOpen ? (
        <Dialog
          isOpen
          purpose="form"
          width={720}
          maxHeight="90vh"
          aria-label="调度配置"
          onOpenChange={(open) => setScheduleOpen(open)}
        >
          <VStack gap={3}>
            <HStack justify="end">
              <Button
                label="关闭调度配置"
                icon={<Icon icon="close" size="sm" />}
                isIconOnly
                variant="ghost"
                size="sm"
                onClick={() => setScheduleOpen(false)}
              />
            </HStack>
            <ScheduleControl client={client} conversation={selected} onScheduleChanged={handleScheduleChanged} />
          </VStack>
        </Dialog>
      ) : null}
      {createOpen ? <RosterPicker client={client} onPick={handlePick} onCancel={handleCancelCreate} busy={creating} error={createError} /> : null}
    </HStack>
  );
}
