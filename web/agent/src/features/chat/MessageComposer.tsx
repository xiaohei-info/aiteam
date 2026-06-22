/**
 * W-A.2 消息输入器（底部）—— 发消息后起 run（POST /conversations/{id}/runs）触发 AI 处理。
 */
import { useState, type FormEvent } from "react";
import { Button } from "@aiteam/shared/ui";
import { useApiError, useApp } from "../../lib/app-context";
import { sendMessage, startRun } from "./useChatApi";

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
      // 起 run 触发 AI 处理，时间线产出 BusinessTimelineEvent。
      await startRun(client, conversationId);
      setContent("");
      onSent();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="flex flex-col gap-xs border-t border-gold/15 p-md" onSubmit={handleSubmit}>
      <textarea
        className="resize-y rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none focus:ring-2 focus:ring-gold"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="输入消息…"
        rows={2}
        disabled={sending}
        aria-label="消息内容"
      />
      {error && <div className="text-xs text-danger">{error}</div>}
      <Button type="submit" className="self-end" disabled={sending || content.trim().length === 0}>
        {sending ? "发送中…" : "发送"}
      </Button>
    </form>
  );
}
