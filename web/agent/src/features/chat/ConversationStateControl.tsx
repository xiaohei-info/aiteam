/**
 * W-A.2 会话状态控制（#314）—— 展示当前主状态 + 合法转换动作按钮。
 *
 * 状态机口径对齐 app/team_panel/domain/entities.py:Conversation：
 *   draft → active / archived
 *   active → paused / muted / archived
 *   paused → active / archived
 *   muted → active / archived
 *   archived → （终态，无出边）
 *
 * 只渲染合法转换对应的按钮；非法转换由后端兜底校验（Conflict 409）。
 * 主线状态（ConversationState）用中文文案；不落展示态（D6）。
 */

import { useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel } from "@aiteam/shared/ui";

import type { AgentApiClient } from "../../lib/api-client";
import type { Conversation } from "./useChatApi";
import { setConversationState } from "./useChatApi";

type Transition = { to: string; label: string };

/** 会话主状态机合法出边（对齐后端 _CONVERSATION_TRANSITIONS）。 */
const TRANSITIONS: Record<string, Transition[]> = {
  draft: [{ to: "active", label: "激活" }],
  active: [
    { to: "paused", label: "暂停" },
    { to: "muted", label: "静音" },
    { to: "archived", label: "归档" },
  ],
  paused: [
    { to: "active", label: "恢复" },
    { to: "archived", label: "归档" },
  ],
  muted: [
    { to: "active", label: "取消静音" },
    { to: "archived", label: "归档" },
  ],
  archived: [],
};

const STATE_LABELS: Record<string, string> = {
  draft: "草稿",
  active: "活跃",
 "paused": "已暂停",
  muted: "已静音",
  archived: "已归档",
};

export interface ConversationStateControlProps {
  client: AgentApiClient;
  conversation: Conversation;
  /** 状态变更成功后回调（父组件刷新选中会话）。 */
  onStateChanged: (conversation: Conversation) => void;
}

export function ConversationStateControl({
  client,
  conversation,
  onStateChanged,
}: ConversationStateControlProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transitions = TRANSITIONS[conversation.state] ?? [];
  const stateLabel = STATE_LABELS[conversation.state] ?? conversation.state;

  async function handleTransition(to: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await setConversationState(client, conversation.id, to);
      if (updated) onStateChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "状态变更失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassPanel className="flex flex-col gap-sm rounded-window">
      <div className="flex items-center justify-between gap-sm">
        <span className="text-sm font-semibold text-text-primary">会话状态</span>
        <span data-testid="conv-state-label" className="text-xs text-text-secondary">
          {stateLabel}
        </span>
      </div>
      {transitions.length > 0 ? (
        <div className="flex flex-wrap gap-xs">
          {transitions.map((t) => (
            <Button
              key={t.to}
              type="button"
              variant={t.to === "archived" ? "danger" : "ghost"}
              size="sm"
              disabled={busy}
              onClick={() => void handleTransition(t.to)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      ) : (
        <span className="text-xs text-text-muted">终态，无可执行操作</span>
      )}
      {error && <p className="m-0 text-xs text-danger">{error}</p>}
    </GlassPanel>
  );
}
