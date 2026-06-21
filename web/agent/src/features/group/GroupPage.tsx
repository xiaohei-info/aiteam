/**
 * W-A.3 群聊页（#68）—— 单机多专家 @提及协作 + 多 run 并入同一时间线（06 §7.6 / D19）。
 *
 * 组合（最大化复用 chat 模块）：
 *   左：ConversationList（复用，headerLabel="群聊"）
 *   右：TimelineView（复用——TimelineStore 按 cursor 归并，多 run 事件天然并入同一时间线）
 *       + GroupExpertRoster（演示用 mock roster）
 *       + MentionComposer（@提及 -> group-dispatch）
 *       + triggered_handles 展示（"@提及触发了哪些专家"）
 *
 * 展示态不入持久化主状态（D6）：selected / roster / lastTriggered / dispatchSignal
 * 均为本组件局部运行态，不写入 store、不落库。
 *
 * roster 说明：后端无"列出会话已装载专家"端点，group-dispatch 按请求体携带 experts 编排
 *（后端 group.py 注释明确"本卡按请求携带即可端到端验证"）。真实来源是 pull 装载的 employee
 *  快照（留详设），本卡用 mock roster 端到端验证 @提及编排链路。
 *
 * roster 点击 -> 输入框追加：用 window CustomEvent（"group:append-mention"）解耦，
 * MentionComposer 内部 useEffect 监听，避免组件间 ref/状态提升耦合。
 */

import { useCallback, useState } from "react";

import { useApp } from "../../lib/app-context";
import { GlassPanel } from "@aiteam/shared/ui";
import { ConversationList } from "../chat/ConversationList";
import { TimelineView } from "../chat/TimelineView";
import type { Conversation } from "../chat/useChatApi";
import { GroupExpertRoster } from "./GroupExpertRoster";
import { MentionComposer } from "./MentionComposer";
import type { DispatchResult, GroupExpert } from "./useGroupApi";

// 演示用 mock roster（真实来源是 pull 装载的 employee 快照，留详设）。
const DEMO_ROSTER: GroupExpert[] = [
  { handle: "专家A", model: "gpt-5" },
  { handle: "专家B", model: "claude-sonnet" },
];

export function GroupPage() {
  const { client } = useApp();
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [roster] = useState<GroupExpert[]>(DEMO_ROSTER);
  const [lastTriggered, setLastTriggered] = useState<string[] | null>(null);
  // 一轮编排完成后 +1，触发列表刷新 + timeline catchUp（补拉 since highWater 的新事件）。
  const [dispatchSignal, setDispatchSignal] = useState(0);

  const handleSelect = useCallback((conv: Conversation) => {
    setSelected(conv);
    setLastTriggered(null);
  }, []);

  const handleDispatched = useCallback((result: DispatchResult) => {
    setLastTriggered(result.triggered_handles);
    setDispatchSignal((n) => n + 1);
  }, []);

  const handlePickHandle = useCallback((handle: string) => {
    window.dispatchEvent(new CustomEvent("group:append-mention", { detail: handle }));
  }, []);

  return (
    <div className="flex h-full min-h-0 gap-md">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={dispatchSignal}
        headerLabel="群聊"
      />
      <GlassPanel className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-md border-b border-gold/15 px-md py-sm">
              <GroupExpertRoster experts={roster} onPickHandle={handlePickHandle} />
              {lastTriggered && lastTriggered.length > 0 && (
                <div className="text-xs font-semibold text-success" aria-live="polite">
                  本轮 @提及触发：{lastTriggered.map((h) => `@${h}`).join(" ")}
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
              experts={roster}
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
  );
}
