/**
 * W-A.2 私聊对话页 —— 组合：左侧会话列表 + 选中后右侧时间线 + 底部输入器。
 *
 * 展示态不入持久化主状态（D6）：selected / timelineRefreshSignal / createOpen /
 * createError 均为本组件局部运行态，不写入 store、不落库。TimelineStore 内部 buffer
 * 也只在内存中存活（卸载即丢）。
 */

import { useCallback, useState } from "react";
import { Button, GlassPanel, cn } from "@aiteam/shared/ui";

import { useApp, useApiError } from "../../lib/app-context";
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

export function ChatPage() {
  const { client } = useApp();
  const toMessage = useApiError();
  const [selected, setSelected] = useState<Conversation | null>(null);
  // 发送消息后 +1，触发列表刷新（updated_at）+ timeline catchUp。
  const [sentSignal, setSentSignal] = useState(0);
  // Loop 面板展开态（局部运行态，不落库）。
  const [loopPanelOpen, setLoopPanelOpen] = useState(false);
  // "新建对话"专家选择弹层 + 创建中错误（局部运行态，D6）。
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleSelect = useCallback((conv: Conversation) => setSelected(conv), []);
  const handleSent = useCallback(() => setSentSignal((n) => n + 1), []);

  const handleCancelCreate = useCallback(() => {
    if (creating) return;
    setCreateOpen(false);
    setCreateError(null);
  }, [creating]);

  const handlePick = useCallback(
    async (expert: LoadedExpertProjection) => {
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
        setSentSignal((n) => n + 1);
        setCreateOpen(false);
      } catch (err) {
        setCreateError(toMessage(err));
      } finally {
        setCreating(false);
      }
    },
    [client, creating, toMessage],
  );

  return (
    <div className="flex h-full min-h-0 gap-md">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={sentSignal}
        onCreate={() => setCreateOpen(true)}
      />
      <GlassPanel className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window">
        {selected ? (
          <>
            <div className="px-md pt-md">
              <ConversationStateControl
                client={client}
                conversation={selected}
                onStateChanged={setSelected}
              />
            </div>
            <div className="flex items-center justify-between border-b border-gold/10 px-md py-sm">
              <span className="truncate text-sm font-semibold text-text-primary">
                {selected.title ?? selected.id}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={loopPanelOpen}
                aria-label="任务编排"
                title="任务编排（Loop 周期任务队列）"
                className={cn("gap-xs", loopPanelOpen && "bg-surface-raised text-gold-bright")}
                onClick={() => setLoopPanelOpen((v) => !v)}
              >
                🦞 编排
              </Button>
            </div>
            {loopPanelOpen && (
              <div className="px-md pt-sm">
                <LoopPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} />
              </div>
            )}
            <TimelineView
              client={client}
              conversationId={selected.id}
              refreshSignal={sentSignal}
            />
            <div className="px-md pb-sm">
              <RunsPanel client={client} conversationId={selected.id} refreshSignal={sentSignal} />
            </div>
            <MessageComposer conversationId={selected.id} onSent={handleSent} />
            <div className="min-h-0 flex-1 px-md pb-md pt-sm">
              <TerminalPanel
                client={client}
                conversationId={selected.id}
                refreshSignal={sentSignal}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-md text-text-muted">
            <div>选择一个会话开始对话</div>
            <Button type="button" onClick={() => setCreateOpen(true)}>
              ＋ 新建对话
            </Button>
          </div>
        )}
      </GlassPanel>
      {createOpen && (
        <RosterPicker
          client={client}
          onPick={handlePick}
          onCancel={handleCancelCreate}
          busy={creating}
          error={createError}
        />
      )}
    </div>
  );
}
