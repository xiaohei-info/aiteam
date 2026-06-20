/**
 * W-A.2 私聊对话页 —— 组合：左侧会话列表 + 选中后右侧时间线 + 底部输入器。
 *
 * 展示态不入持久化主状态（D6）：selectedId / timelineRefreshSignal 均为本组件局部运行态，
 * 不写入 store、不落库。TimelineStore 内部 buffer 也只在内存中存活（卸载即丢）。
 */

import { useCallback, useState } from "react";

import { useApp } from "../../lib/app-context";
import type { Conversation } from "./useChatApi";
import { ConversationList } from "./ConversationList";
import { TimelineView } from "./TimelineView";
import { MessageComposer } from "./MessageComposer";

export function ChatPage() {
  const { client } = useApp();
  const [selected, setSelected] = useState<Conversation | null>(null);
  // 发送消息后 +1，触发列表刷新（updated_at）+ timeline catchUp。
  const [sentSignal, setSentSignal] = useState(0);

  const handleSelect = useCallback((conv: Conversation) => setSelected(conv), []);
  const handleSent = useCallback(() => setSentSignal((n) => n + 1), []);

  return (
    <div className="chat-page">
      <ConversationList
        client={client}
        selectedId={selected?.id ?? null}
        onSelect={handleSelect}
        refreshSignal={sentSignal}
      />
      <div className="chat-panel">
        {selected ? (
          <>
            <TimelineView
              client={client}
              conversationId={selected.id}
              refreshSignal={sentSignal}
            />
            <MessageComposer conversationId={selected.id} onSent={handleSent} />
          </>
        ) : (
          <div className="chat-panel__empty">选择一个会话开始对话</div>
        )}
      </div>
    </div>
  );
}
