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
 * dispatchSignal / createError 均为本组件局部运行态，不写入 store、不落库。
 *
 * roster 说明：真实来源是 pull 装载的 employee 快照（GET /api/agent/grants/experts），
 * 本卡直接取用。
 *
 * roster 点击 -> 输入框追加：用 window CustomEvent（"group:append-mention"）解耦，
 * MentionComposer 内部 useEffect 监听，避免组件间 ref/状态提升耦合。
 */

import { useCallback, useEffect, useState } from "react";

import { useApp, useApiError } from "../../lib/app-context";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { ConversationList } from "../chat/ConversationList";
import { TimelineView } from "../chat/TimelineView";
import type { Conversation } from "../chat/useChatApi";
import { createConversation } from "../chat/useChatApi";
import { GroupExpertRoster } from "./GroupExpertRoster";
import { MentionComposer } from "./MentionComposer";
import { listLoadedExperts, type DispatchResult, type GroupExpert } from "./useGroupApi";

/**
 * 把 LoadedExpertProjection 投影成群聊编排所需的 GroupExpert。
 * handle 用 display_name（@提及入口友好）；persona/model 留待 RunSpec 派生。
 */
function toGroupExpert(p: { display_name: string; runtime_binding?: string | null }): GroupExpert {
  return {
    handle: p.display_name,
    ...(p.runtime_binding ? { model: p.runtime_binding } : {}),
  };
}

export function GroupPage() {
  const { client } = useApp();
  const toMessage = useApiError();
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [roster, setRoster] = useState<GroupExpert[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [lastTriggered, setLastTriggered] = useState<string[] | null>(null);
  const [lastIgnored, setLastIgnored] = useState<string[] | null>(null);
  // 一轮编排完成后 +1，触发列表刷新 + timeline catchUp（补拉 since highWater 的新事件）。
  const [dispatchSignal, setDispatchSignal] = useState(0);
  // 建群中状态 + 错误（局部运行态，D6）。
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 拉取真实 roster（GET /api/agent/grants/experts），替代演示用 mock。
  useEffect(() => {
    let cancelled = false;
    listLoadedExperts(client)
      .then((items) => {
        if (cancelled) return;
        setRoster(items.filter((p) => !p.revoked).map(toGroupExpert));
        setRosterError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setRosterError(err instanceof Error ? err.message : "加载专家失败");
      });
    return () => { cancelled = true; };
  }, [client]);

  const handleSelect = useCallback((conv: Conversation) => {
    setSelected(conv);
    setLastTriggered(null);
    setLastIgnored(null);
  }, []);

  const handleDispatched = useCallback((result: DispatchResult) => {
    setLastTriggered(result.triggered_handles);
    setLastIgnored(result.ignored_handles ?? null);
    setDispatchSignal((n) => n + 1);
  }, []);

  const handlePickHandle = useCallback((handle: string) => {
    window.dispatchEvent(new CustomEvent("group:append-mention", { detail: handle }));
  }, []);

  const handleNewGroup = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createConversation(client, {
        title: "新建群聊",
        collaboration_mode: "free",
      });
      if (!created) {
        setCreateError(toMessage(new Error("建群返回为空")));
        return;
      }
      setSelected(created);
      setLastTriggered(null);
      setLastIgnored(null);
      setDispatchSignal((n) => n + 1);
    } catch (err) {
      setCreateError(toMessage(err));
    } finally {
      setCreating(false);
    }
  }, [client, creating, toMessage]);

  return (
    <div className="flex h-full min-h-0 gap-md">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={dispatchSignal}
        headerLabel="群聊"
        onCreate={handleNewGroup}
      />
      <GlassPanel className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-md border-b border-gold/15 px-md py-sm">
              <GroupExpertRoster experts={roster} onPickHandle={handlePickHandle} />
              {rosterError && (
                <div className="text-xs text-danger" aria-live="polite">{rosterError}</div>
              )}
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
              {createError && (
                <div className="text-xs text-danger" role="alert">{createError}</div>
              )}
            </div>
            <TimelineView
              client={client}
              conversationId={selected.id}
              refreshSignal={dispatchSignal}
            />
            <MentionComposer
              conversationId={selected.id}
              experts={roster}
              onDispatched={handleDispatched}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-md text-text-muted">
            <div>选择一个群聊会话开始多专家协作</div>
            <Button type="button" onClick={handleNewGroup} disabled={creating}>
              {creating ? "创建中…" : "＋ 新建群聊"}
            </Button>
            {createError && (
              <div className="text-sm text-danger" role="alert">{createError}</div>
            )}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
