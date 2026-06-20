/**
 * W-A.2 消息输入器（底部）—— 发送消息 POST /api/agent/conversations/{id}/messages。
 *
 * 最小必要：单行 textarea + 发送按钮。发送中禁用，错误内联展示。
 * 发送后清空输入并 onSent 回调（父组件据此触发 timeline catchUp）。
 */

import { useState, type FormEvent } from "react";

import { useApiError, useApp } from "../../lib/app-context";
import { sendMessage } from "./useChatApi";

export interface MessageComposerProps {
  conversationId: string;
  onSent: () => void;
}

export function MessageComposer({ conversationId, onSent }: MessageComposerProps) {
  const { client } = useApp();
  const toMessage = useApiError();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(client, conversationId, { content: text });
      setContent("");
      onSent();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <textarea
        className="chat-composer__input"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="输入消息…"
        rows={2}
        disabled={sending}
        aria-label="消息内容"
      />
      {error && <div className="chat-composer__error">{error}</div>}
      <button
        type="submit"
        className="chat-composer__send"
        disabled={sending || content.trim().length === 0}
      >
        {sending ? "发送中…" : "发送"}
      </button>
    </form>
  );
}
