/**
 * W-A.3 群聊 @提及输入器（#68 / 06 §7.6 / D19）。
 *
 * 与私聊 MessageComposer 的差异：发送时走 POST /group-dispatch（而非 /messages），
 * 请求体携带本会话 roster（后端按 roster 解析 @提及、各起一个 run）。@解析只认 roster
 * 内已知 handle（与后端 mentions.resolve_mentions 口径一致——未知 handle 不触发 run）。
 *
 * 发送后清空输入并回调 onDispatched（父组件据此触发 timeline catchUp + 展示
 * triggered_handles）。展示态不入持久化主状态（D6）。
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useApiError, useApp } from "../../lib/app-context";
import type { DispatchResult, GroupExpert } from "./useGroupApi";
import { groupDispatch } from "./useGroupApi";

export interface MentionComposerProps {
  conversationId: string;
  /** 本会话已装载专家 roster（演示用，前端持有）。 */
  experts: GroupExpert[];
  /** 一轮编排完成后回调，参数为本轮 DispatchResult（含 triggered_handles）。 */
  onDispatched: (result: DispatchResult) => void;
}

/**
 * 解析输入文本里 @提及的 handle，只保留 roster 已知的。
 * @handle 取「@后到空白/字符串尾」的连续非空白片段（与后端 mentions 解析口径对齐）。
 */
export function parseMentions(text: string, knownHandles: Set<string>): string[] {
  const matches = text.match(/@([^\s@]+)/g) ?? [];
  const seen = new Set<string>();
  for (const m of matches) {
    const handle = m.slice(1);
    if (knownHandles.has(handle) && !seen.has(handle)) seen.add(handle);
  }
  return [...seen];
}

export function MentionComposer({ conversationId, experts, onDispatched }: MentionComposerProps) {
  const { client } = useApp();
  const toMessage = useApiError();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const knownHandles = useMemo(() => new Set(experts.map((e) => e.handle)), [experts]);
  const mentioned = useMemo(() => parseMentions(content, knownHandles), [content, knownHandles]);

  // roster 点击 handle -> 追加 "@handle " 到输入框（通过 window CustomEvent 解耦）。
  useEffect(() => {
    const onAppend = (ev: Event) => {
      const handle = (ev as CustomEvent<string>).detail;
      if (typeof handle !== "string" || !handle) return;
      setContent((prev) => {
        const prefix = prev && !prev.endsWith(" ") ? `${prev} ` : prev;
        return `${prefix}@${handle} `;
      });
    };
    window.addEventListener("group:append-mention", onAppend);
    return () => window.removeEventListener("group:append-mention", onAppend);
  }, []);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      // 携带完整 roster（后端按 roster 解析 @提及）；即便本轮无 @，也发原文（后端落 USER 消息、不起 run）。
      const result = await groupDispatch(client, conversationId, { text, experts });
      setContent("");
      onDispatched(result);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="chat-composer group-composer" onSubmit={handleSubmit}>
      <textarea
        className="chat-composer__input"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="输入消息，@专家 触发协作…"
        rows={2}
        disabled={sending}
        aria-label="群聊消息内容"
      />
      {mentioned.length > 0 && (
        <div className="group-composer__mentions" aria-live="polite">
          将触发：{mentioned.map((h) => `@${h}`).join(" ")}
        </div>
      )}
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
