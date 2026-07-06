/**
 * W-A.3 群聊页（#68）—— 单机多专家 @提及协作 + 多 run 并入同一时间线（06 §7.6 / D19）。
 *
 * 组合（最大化复用 chat 模块）：
 *   左：ConversationList（复用，headerLabel="群聊"）
 *   右：TimelineView（复用——TimelineStore 按 cursor 归并，多 run 事件天然并入同一时间线）
 *       + GroupExpertRoster（拉取真实 roster）
 *       + MentionComposer（@提及 -> group-dispatch）
 *       + triggered_handles 展示（"@提及触发了哪些专家"）
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
 * 建群入口（"都选方案一" 第四章决策）：固定编排入口位于本页面顶部 header 条，点"从解决方案创建群聊"
 * 打开 Modal 选择 Operator 行业方案实例——选中后 POST /conversations 走固定编排（solution 自带
 * 三阶段 prompts，UI 只读展示不覆盖）；自由创建仍为默认行为。
 */

import { useCallback, useEffect, useState, useMemo } from "react";

import { useApp } from "../../lib/app-context";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { ConversationList } from "../chat/ConversationList";
import { TimelineView } from "../chat/TimelineView";
import type { Conversation } from "../chat/useChatApi";
import { GroupExpertRoster } from "./GroupExpertRoster";
import { MentionComposer } from "./MentionComposer";
import {
  createConversationFromSolution,
  createFreeConversation,
  listLoadedExperts,
  listSolutionInstances,
  type CreateFromSolutionInput,
  type DispatchResult,
  type GroupExpert,
  type LoadedExpertProjection,
  type SolutionProjection,
} from "./useGroupApi";

/**
 * 把 LoadedExpertProjection 投影成群聊编排所需的 GroupExpert。
 * handle 用 display_name（@提及入口友好）；persona/model 留待 RunSpec 派生。
 */
function toGroupExpert(p: {
  handle: string;
  display_name: string;
  employee_id?: string | null;
  runtime_binding?: string | null;
}): GroupExpert {
  // M1：不再把 runtime_binding 塞进 model（前端 model 不作为权威配置）；
  // 后端按 employee_id 从专家快照派生 RunSpec。
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
  const [lastTriggered, setLastTriggered] = useState<string[] | null>(null);
  const [lastIgnored, setLastIgnored] = useState<string[] | null>(null);
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
    setLastTriggered(null);
    setLastIgnored(null);
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

  const handleDispatched = useCallback((result: DispatchResult) => {
    setLastTriggered(result.triggered_handles);
    setLastIgnored(result.ignored_handles ?? null);
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
      const input: CreateFromSolutionInput = {
        solution_instance_id: sol.solution_instance_id,
        title: sol.display_name || "方案群聊",
      };
      const conv = await createConversationFromSolution(client, input);
      setShowCreateModal(false);
      setDispatchSignal((n) => n + 1);
      setSelected(conv);
    } catch (err) {
      setSolutionsError("创建群聊失败");
    } finally {
      setCreating(false);
    }
  }, [selectedSolutionId, solutions, client]);

  const handleCreateFree = useCallback(async () => {
    setFreeCreateError(null);
    setFreeCreating(true);
    try {
      const title = window.prompt("自由群聊名称", "自由协作群");
      if (title === null) return;
      const conv = await createFreeConversation(client, { title });
      setDispatchSignal((n) => n + 1);
      setSelected(conv);
    } catch (err) {
      setFreeCreateError("创建自由群聊失败");
    } finally {
      setFreeCreating(false);
    }
  }, [client]);

  return (
    <div className="flex h-full min-h-0 gap-md">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={dispatchSignal}
        headerLabel="群聊"
        // 群聊页只列群会话（排除 entry_employee_id 非空的私聊），防止私聊被当做群聊进入编排。
        filter={(c) => c.entry_employee_id == null}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-md">
        <div className="flex flex-wrap items-center justify-between gap-sm rounded-window border border-gold/15 bg-surface-raised px-md py-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <span className="text-sm font-semibold text-text-primary">群聊协作</span>
            {rosterError && (
              <span className="text-xs text-danger" role="alert" aria-live="polite">{rosterError}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            <Button size="sm" variant="metal" onClick={handleOpenCreate}>
              从解决方案创建群聊
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void handleCreateFree()} disabled={freeCreating}>
              {freeCreating ? "创建中…" : "创建自由群聊"}
            </Button>
            {freeCreateError && (
              <span className="text-xs text-danger" role="alert">{freeCreateError}</span>
            )}
          </div>
        </div>
      <GlassPanel className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-md border-b border-gold/15 px-md py-sm">
              <GroupExpertRoster experts={rosterForSelected} onPickHandle={handlePickHandle} />
              {lastTriggered && lastTriggered.length > 0 && (
                <div className="text-xs font-semibold text-success" aria-live="polite">
                  本轮 @提及触发：{lastTriggered.map((h) => `@${h}`).join(" ")}
                </div>
              )}
              {lastIgnored && lastIgnored.length > 0 && (
                <div className="text-xs text-danger" aria-live="polite" role="alert">
                  未识别的专家：{lastIgnored.join(" ")}（请检查 roster 中的展示名）
                </div>
              )}
            </div>
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
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            选择一个群聊会话开始多专家协作
          </div>
        )}
      </GlassPanel>
      </div>

      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg-canvas/80 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="从解决方案创建群聊"
          onClick={handleCloseCreate}
        >
          <GlassPanel
            className="w-full max-w-lg space-y-md p-lg"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-text-primary">从解决方案创建群聊</h2>
            <p className="text-sm text-text-secondary">
              选择一个行业方案实例，将以其自带的三阶段固定编排规则（planner / subtask / aggregate）创建群聊。
              创建后编排规则只读，不可在会话中覆盖。
            </p>
            {solutions === null ? (
              <p className="text-sm text-text-secondary">加载中…</p>
            ) : solutions.length === 0 ? (
              <p className="text-sm text-danger">暂无可用方案实例，请先在 Manager 端应用方案后再来建群。</p>
            ) : (
              <div className="space-y-xs">
                <label className="block text-xs font-medium text-text-secondary">选择方案实例</label>
                <select
                  className="w-full rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none focus:border-gold/50 focus:ring-2 focus:ring-gold"
                  value={selectedSolutionId ?? ""}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSelectedSolutionId(e.target.value || null)}
                >
                  <option value="">— 请选择 —</option>
                  {solutions.map((s) => (
                    <option key={s.solution_instance_id} value={s.solution_instance_id}>
                      {s.display_name}{s.version ? ` · v${s.version}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {solutionsError && (
              <p className="text-xs text-danger" aria-live="polite">{solutionsError}</p>
            )}
            <div className="flex justify-end gap-sm">
              <Button variant="ghost" onClick={handleCloseCreate} disabled={creating}>
                取消
              </Button>
              <Button
                variant="metal"
                disabled={!selectedSolutionId || !solutions || solutions.length === 0 || creating}
                onClick={() => void handleConfirmCreate()}
              >
                {creating ? "创建中…" : "创建群聊"}
              </Button>
            </div>
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
