/**
 * W-A.3 群聊页（#68）—— 单机多专家 @提及协作 + 多 run 并入同一时间线（06 §7.6 / D19）。
 *
 * 组合（最大化复用 chat 模块）：
 *   左：ConversationList（复用，headerLabel="群聊"）
 *   右：TimelineView（复用——TimelineStore 按 cursor 归并，多 run 事件天然并入同一时间线）
 *       + GroupExpertRoster（只读 roster 投影）
 *       + MentionComposer（@提及 -> coordinator prompt）
 *
 * 展示态不入持久化主状态（D6）：selected / roster / lastTriggered / lastIgnored /
 * dispatchSignal 均为本组件局部运行态，不写入 store、不落库。
 *
 * roster 说明：真实来源是 pull 装载的 employee 快照（GET /api/agent/grants/experts），
 * 本卡直接取用。
 *
 * roster 点击 -> 输入框追加：用 window CustomEvent（"group:append-mention"）解耦，
 * MentionComposer 内部 useEffect 监听，避免组件间 ref/状态提升耦合。
 *
 * 建群入口只在本地保存会话索引；方案内容是只读授权投影，不向 Agent 发送 planner payload。
 */

import { useCallback, useEffect, useState, useMemo } from "react";

import { useApp } from "../../lib/app-context";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { VStack } from "@astryxdesign/core/VStack";
import { ConversationList } from "../chat/ConversationList";
import { TimelineView } from "../chat/TimelineView";
import type { Conversation } from "../chat/useChatApi";
import { GroupExpertRoster } from "./GroupExpertRoster";
import { MentionComposer } from "./MentionComposer";
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
function toGroupExpert(p: {
  handle: string;
  display_name: string;
  employee_id?: string | null;
}): GroupExpert {
  return {
    handle: p.handle,
    display_name: p.display_name,
    ...(p.employee_id ? { employee_id: p.employee_id } : {}),
  };
}

export function GroupPage() {
  const { client } = useApp();
  const [selected, setSelected] = useState<Conversation | null>(null);
  // 已装载专家原始投影列表（含 employee_id 供方案绑定 roster 过滤）。
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // 一轮编排完成后 +1，触发列表刷新 + timeline catchUp（补拉 since highWater 的新事件）。
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
    setSelected(conv);
  }, []);

  // 全部已装载专家 -> GroupExpert roster。
  const roster = useMemo(
    () => experts.filter((p) => !p.revoked).map(toGroupExpert),
    [experts],
  );

  // 方案绑定会话的 roster 动态过滤：仅展示 solution_expert_employee_ids 中的专家。
  // 已用 stable handle（backend ASCII / employee_id）直接匹配，不再通过 display_name 反查。
  const rosterForSelected = useMemo(() => {
    const ids = selected?.solution_expert_employee_ids;
    if (!selected || !ids || ids.length === 0) return roster;
    const allowed = new Set(ids);
    const filtered = roster.filter((e) => allowed.has(e.handle));
    return filtered.length > 0 ? filtered : roster;
  }, [selected, roster]);

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
      const coordinator = sol.expert_employee_ids?.map((id) => experts.find((expert) => expert.employee_id === id)).find(Boolean)
        ?? experts.find((expert) => !expert.revoked);
      if (!coordinator) {
        setSolutionsError("暂无可授权的群聊协调专家");
        return;
      }
      const conv = await createGroupConversation(client, {
        solution_instance_id: sol.solution_instance_id,
        title: sol.display_name || "方案群聊",
        coordinator_employee_id: coordinator.employee_id,
      });
      if (!conv) {
        setSolutionsError("创建群聊返回为空");
        return;
      }
      setShowCreateModal(false);
      setDispatchSignal((n) => n + 1);
      setSelected(conv);
    } catch (err) {
      setSolutionsError("创建群聊失败");
    } finally {
      setCreating(false);
    }
  }, [selectedSolutionId, solutions, experts, client]);

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
      setSelected(conv);
    } catch (err) {
      setFreeCreateError("创建自由群聊失败");
    } finally {
      setFreeCreating(false);
    }
  }, [client, experts]);

  return (
    <HStack gap={4} height="100%" minHeight={0}>
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={dispatchSignal}
        headerLabel="群聊"
        // 群聊页只列 kind=group 会话；私聊也有 entry_employee_id，不能靠员工字段判型。
        filter={(c) => c.kind === "group" || (c.kind === undefined && c.entry_employee_id == null)}
      />
      <VStack gap={4} width="100%" minHeight={0}>
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
          <VStack gap={2} padding={4}>
            <Toolbar
              label="群聊专家与编排状态"
              startContent={<GroupExpertRoster experts={rosterForSelected} onPickHandle={handlePickHandle} />}
              endContent={
                <VStack gap={1} align="end">
                  <Text type="supporting" as="div" aria-live="polite">
                    @提及将由 coordinator Conversation 处理
                  </Text>
                </VStack>
              }
            />
            <TimelineView
              client={client}
              conversationId={selected.id}
              refreshSignal={dispatchSignal}
            />
            <MentionComposer
              conversationId={selected.id}
              experts={rosterForSelected}
              onDispatched={handleDispatched}
            />
          </VStack>
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
              选择一个行业方案实例，将以其自带的三阶段固定编排规则（planner / subtask / aggregate）创建群聊。
              创建后编排规则只读，不可在会话中覆盖。
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
    </HStack>
  );
}
