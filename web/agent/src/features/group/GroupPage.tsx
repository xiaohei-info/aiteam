/**
 * W-A.3 群聊页（#68）—— 单机多专家 @提及协作，共享本地 Pi conversation 事件流（06 §7.6 / D19）。
 *
 * 组合（最大化复用 chat 模块）：
 *   左：ConversationList（复用，headerLabel="群聊"）
 *   右：TimelineView（复用——消费本地 Pi conversation entries 与 event stream）
 *       + GroupExpertRoster（只读 roster 投影）
 *       + MessageComposer（与私聊共用 prompt/entries/SSE/abort/附件链路）
 *
 * 展示态不入持久化主状态（D6）：selected / roster / lastTriggered / lastIgnored /
 * dispatchSignal 均为本组件局部运行态，不写入 store、不落库。
 *
 * roster 说明：真实来源是 pull 装载的 employee 快照（GET /api/agent/grants/experts），
 * 本卡直接取用。
 *
 * roster 点击 -> 输入框追加：用 window CustomEvent（"group:append-mention"）解耦，
 * MessageComposer 统一监听并负责真正的 prompt 提交。
 *
 * 建群入口只提交 solution_instance_id；coordinator/roster 由授权投影决定，不由浏览器提交。
 */

import { useCallback, useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { useApp } from "../../lib/app-context";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { VStack } from "@astryxdesign/core/VStack";
import { ConversationList } from "../chat/ConversationList";
import { MessageComposer } from "../chat/MessageComposer";
import { TimelineView } from "../chat/TimelineView";
import { FilesPanel } from "../chat/FilesPanel";
import type { Conversation } from "../chat/useChatApi";
import { GroupExpertRoster } from "./GroupExpertRoster";
import {
  createGroupConversation,
  listLoadedExperts,
  listSolutionInstances,
  type GroupExpert,
  type LoadedExpertProjection,
  type SolutionProjection,
} from "./useGroupApi";

/**
 * 把 LoadedExpertProjection 投影成群聊编排所需的 GroupExpert。
 * handle 用 display_name（@提及入口友好）；模型策略由 Agent 的 Pi 会话快照提供。
 */
const formatConversationTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
};

const isGroupConversation = (conversation: Conversation) => conversation.kind === "group" || (conversation.kind === undefined && conversation.entry_employee_id == null);

function toGroupExpert(p: {
  handle: string;
  display_name: string;
  employee_id?: string | null;
  avatar_url?: string | null;
}): GroupExpert {
  return {
    handle: p.handle,
    display_name: p.display_name,
    ...(p.employee_id ? { employee_id: p.employee_id } : {}),
    ...(p.avatar_url ? { avatar_url: p.avatar_url } : {}),
  };
}

export function GroupPage() {
  const { client } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedConversationId = searchParams.get("conversation_id");
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // 已装载专家原始投影列表；方案群聊只允许在本地授权 roster 内提及。
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // A submitted prompt increments this signal so the conversation list and local Pi entries refresh.
  const [dispatchSignal, setDispatchSignal] = useState(0);
  // "从解决方案创建群聊" 固定编排入口：列表+弹窗状态
  const [solutions, setSolutions] = useState<SolutionProjection[] | null>(null);
  const [solutionsError, setSolutionsError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [freeCreating, setFreeCreating] = useState(false);
  const [freeCreateError, setFreeCreateError] = useState<string | null>(null);

  // 拉取真实 roster（GET /api/agent/grants/experts），替代演示用 mock。
  useEffect(() => {
    let cancelled = false;
    listLoadedExperts(client)
      .then((items) => {
        if (cancelled) return;
        setExperts(items);
        setRosterError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setRosterError("加载专家失败");
      });
    return () => { cancelled = true; };
  }, [client]);

  const handleSelect = useCallback((conv: Conversation) => {
    setPrompting(false);
    setHistoryOpen(false);
    setSelected(conv);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("conversation_id", conv.id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Filter only when the read-only solution projection explicitly supplies member IDs;
  // otherwise keep the full locally authorized roster instead of inventing a scope.
  useEffect(() => {
    if (!requestedConversationId || selected?.id === requestedConversationId) return;
    const target = conversations.find((conversation) => conversation.id === requestedConversationId);
    if (target) handleSelect(target);
  }, [conversations, handleSelect, requestedConversationId, selected?.id]);

  const participantExperts = useMemo(() => {
    const solutionId = selected?.solution_instance_id;
    const solution = solutionId ? solutions?.find((item) => item.solution_instance_id === solutionId) : undefined;
    const authorized = experts.filter((expert) => !expert.revoked);
    if (!solution || !Array.isArray(solution.expert_employee_ids)) return authorized;
    const allowed = new Set(solution.expert_employee_ids);
    return authorized.filter((expert) => allowed.has(expert.employee_id));
  }, [experts, selected?.solution_instance_id, solutions]);

  const rosterForSelected = useMemo(
    () => participantExperts.map(toGroupExpert),
    [participantExperts],
  );

  const handleDispatched = useCallback(() => {
    setDispatchSignal((n) => n + 1);
  }, []);

  const handlePickHandle = useCallback((handle: string) => {
    window.dispatchEvent(new CustomEvent("group:append-mention", { detail: handle }));
  }, []);

  // 拉取本端可用方案实例（GET /api/agent/grants/solutions）
  const refreshSolutions = useCallback(async () => {
    setSolutionsError(null);
    try {
      const items = await listSolutionInstances(client);
      setSolutions(items);
    } catch (err) {
      setSolutionsError("加载方案列表失败");
    }
  }, [client]);

  useEffect(() => {
    void refreshSolutions();
  }, [refreshSolutions]);

  const handleOpenCreate = useCallback(() => {
    setSelectedSolutionId(null);
    setShowCreateModal(true);
    void refreshSolutions();
  }, [refreshSolutions]);

  const handleCloseCreate = useCallback(() => {
    setShowCreateModal(false);
    setSelectedSolutionId(null);
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    if (!selectedSolutionId || !solutions) return;
    const sol = solutions.find((s) => s.solution_instance_id === selectedSolutionId);
    if (!sol) return;
    setCreating(true);
    try {
      const conv = await createGroupConversation(client, {
        solution_instance_id: sol.solution_instance_id,
        title: sol.display_name || "方案群聊",
      });
      if (!conv) {
        setSolutionsError("创建群聊返回为空");
        return;
      }
      setShowCreateModal(false);
      setDispatchSignal((n) => n + 1);
      handleSelect(conv);
    } catch (err) {
      setSolutionsError("创建群聊失败");
    } finally {
      setCreating(false);
    }
  }, [client, handleSelect, selectedSolutionId, solutions]);

  const handleCreateFree = useCallback(async () => {
    setFreeCreateError(null);
    setFreeCreating(true);
    try {
      const title = window.prompt("自由群聊名称", "自由协作群");
      if (title === null) return;
      const coordinator = experts.find((expert) => !expert.revoked);
      if (!coordinator) {
        setFreeCreateError("暂无可授权的群聊协调专家");
        return;
      }
      const conv = await createGroupConversation(client, {
        title,
        coordinator_employee_id: coordinator.employee_id,
      });
      if (!conv) {
        setFreeCreateError("创建群聊返回为空");
        return;
      }
      setDispatchSignal((n) => n + 1);
      handleSelect(conv);
    } catch (err) {
      setFreeCreateError("创建自由群聊失败");
    } finally {
      setFreeCreating(false);
    }
  }, [client, experts, handleSelect]);

  const handleCreateForSelected = useCallback(async () => {
    if (!selected || creating) return;
    setCreating(true);
    setSolutionsError(null);
    try {
      const created = await createGroupConversation(client, {
        title: selected.title ?? "群聊",
        ...(selected.solution_instance_id
          ? { solution_instance_id: selected.solution_instance_id }
          : selected.coordinator_employee_id
            ? { coordinator_employee_id: selected.coordinator_employee_id }
            : {}),
      });
      if (!created) throw new Error("建会话返回为空");
      handleSelect(created);
      setDispatchSignal((signal) => signal + 1);
    } catch (err) {
      setSolutionsError(err instanceof Error ? err.message : "创建群聊失败");
    } finally {
      setCreating(false);
    }
  }, [client, creating, handleSelect, selected]);

  const history = useMemo(() => {
    if (!selected) return [];
    if (selected.solution_instance_id) {
      return conversations.filter((conversation) => conversation.solution_instance_id === selected.solution_instance_id);
    }
    return conversations.filter((conversation) => conversation.id === selected.id);
  }, [conversations, selected]);

  const conversationTitle = selected?.title ?? "群聊";

  return (
    <HStack gap={4} height="100%" minHeight={0} width="100%" data-testid="group-chat-layout">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={dispatchSignal}
        headerLabel="群聊"
        groupByGroup
        // 群聊页只列 kind=group 会话；私聊也有 entry_employee_id，不能靠员工字段判型。
        filter={isGroupConversation}
        onItemsLoaded={setConversations}
      />
      <VStack data-testid="group-chat-content" gap={4} width="100%" minHeight={0}>
        <Toolbar
          label="群聊协作操作"
          startContent={
            <HStack gap={2} align="center" wrap="wrap">
              <Heading level={1}>群聊协作</Heading>
              {rosterError && <Text type="supporting" role="alert">{rosterError}</Text>}
            </HStack>
          }
          endContent={
            <HStack gap={1} wrap="wrap">
              <Button label="从解决方案创建群聊" size="sm" variant="primary" onClick={handleOpenCreate} />
              <Button
                label="创建自由群聊"
                size="sm"
                variant="secondary"
                onClick={() => void handleCreateFree()}
                isLoading={freeCreating}
              />
            </HStack>
          }
        />
        {freeCreateError && <Banner status="error" title={freeCreateError} />}
      <Card role="region" aria-label="群聊协作工作区" width="100%" padding={0}>
        {selected ? (
          <HStack data-testid="group-conversation-workspace" gap={4} align="stretch" width="100%">
          <VStack data-testid="group-conversation-main" gap={2} padding={4} width="100%">
            <HStack justify="between" align="center" wrap="wrap">
              <Heading level={2}>{conversationTitle}</Heading>
              <HStack gap={1} role="group" aria-label="群聊操作">
                <Button
                  label={`与${conversationTitle}新建对话`}
                  icon={<span aria-hidden="true">＋</span>}
                  isIconOnly
                  tooltip="新建对话"
                  variant="ghost"
                  size="sm"
                  isLoading={creating}
                  onClick={() => void handleCreateForSelected()}
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
              </HStack>
            </HStack>
            <Toolbar
              label="群聊专家 roster"
              startContent={<GroupExpertRoster experts={rosterForSelected} onPickHandle={handlePickHandle} />}
              endContent={<Text type="supporting" as="div" aria-live="polite">不 @ 时由协调专家响应，@ 谁由谁响应</Text>}
            />
            <TimelineView
              client={client}
              conversationId={selected.id}
              refreshSignal={dispatchSignal}
              onPromptingChange={setPrompting}
              sourceExperts={participantExperts}
            />
            <MessageComposer
              conversationId={selected.id}
              conversation={selected}
              onConversationChanged={handleSelect}
              isPrompting={prompting}
              onPromptingChange={setPrompting}
              onSent={handleDispatched}
              refreshSignal={dispatchSignal}
              mentionRoster={participantExperts}
            />
          </VStack>
          <FilesPanel client={client} conversationId={selected.id} refreshSignal={dispatchSignal} isPrompting={prompting} />
          </HStack>
        ) : (
          <EmptyState
            title="选择一个群聊会话"
            description="选择会话后即可开始多专家协作。"
            headingLevel={2}
          />
        )}
      </Card>
      </VStack>

      <Dialog
        isOpen={showCreateModal}
        onOpenChange={(isOpen) => {
          if (!isOpen) handleCloseCreate();
        }}
        aria-label="从解决方案创建群聊"
        purpose="form"
        width={560}
      >
        <VStack gap={4}>
            <Heading level={2}>从解决方案创建群聊</Heading>
            <Text as="p">
              选择一个已授权方案实例创建群聊；服务端会根据方案授权投影确定参与专家和协调专家，
              用户端只提交方案实例 ID。
            </Text>
            {solutions === null ? (
              <Text type="supporting">加载中…</Text>
            ) : solutions.length === 0 ? (
              <Banner status="warning" title="暂无可用方案实例" description="请先在 Manager 端应用方案后再来建群。" />
            ) : (
              <Selector
                label="选择方案实例"
                placeholder="请选择"
                options={solutions.map((solution) => ({
                  value: solution.solution_instance_id,
                  label: `${solution.display_name}${solution.version ? ` · v${solution.version}` : ""}`,
                }))}
                value={selectedSolutionId ?? undefined}
                onChange={setSelectedSolutionId}
                width="100%"
              />
            )}
            {solutionsError && <Banner status="error" title={solutionsError} />}
            <HStack justify="end" gap={2}>
              <Button label="取消" variant="secondary" onClick={handleCloseCreate} isDisabled={creating} />
              <Button
                label="创建群聊"
                variant="primary"
                isDisabled={!selectedSolutionId || !solutions || solutions.length === 0 || creating}
                isLoading={creating}
                onClick={() => void handleConfirmCreate()}
              />
            </HStack>
        </VStack>
      </Dialog>

      {selected && historyOpen ? (
        <Dialog
          isOpen
          purpose="info"
          width={560}
          maxHeight="80vh"
          aria-label="群聊历史对话"
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
            {history.length === 0 ? (
              <EmptyState title="暂无历史对话" isCompact />
            ) : (
              <List aria-label="群聊历史对话" density="balanced" hasDividers>
                {history.map((conversation) => (
                  <ListItem
                    key={conversation.id}
                    label={conversation.title ?? conversation.id}
                    description={formatConversationTime(conversation.updated_at)}
                    endContent={conversation.id === selected.id ? <Badge label="当前" variant="info" /> : undefined}
                    isSelected={conversation.id === selected.id}
                    data-testid={`group-history-${conversation.id}`}
                    onClick={() => handleSelect(conversation)}
                  />
                ))}
              </List>
            )}
          </VStack>
        </Dialog>
      ) : null}
    </HStack>
  );
}
