/**
 * W-A.3 群聊 @提及输入器（#68 / 06 §7.6 / D19）。
 *
 * 群聊与私聊统一走 coordinator Conversation 的 prompt 入口；roster 仅用于本地 @提及提示。
 * @解析只认 roster 内已知 handle，不把 roster 或 planner payload 发送给 Agent。
 *
 * 发送后清空输入并回调 onDispatched（父组件据此触发 timeline catchUp + 展示
 * triggered_handles）。展示态不入持久化主状态（D6）。
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";

import { useApiError, useApp } from "../../lib/app-context";
import type { GroupExpert } from "./useGroupApi";
import { submitPrompt } from "../chat/useChatApi";

export interface MentionComposerProps {
  conversationId: string;
  /** 本地已授权 roster，仅用于 @提及提示。 */
  experts: GroupExpert[];
  /** prompt 被 coordinator 接收后的刷新回调。 */
  onDispatched: () => void;
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
      // Mentions are coordinator instructions in the ordinary Conversation prompt.
      await submitPrompt(client, conversationId, { text });
      setContent("");
      onDispatched();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <VStack gap={1} padding={4}>
      <TextArea
        label="群聊消息内容"
        isLabelHidden
        value={content}
        onChange={setContent}
        placeholder="输入消息，@专家 触发协作…"
        rows={2}
        isDisabled={sending}
        status={error ? { type: "error", message: error } : undefined}
      />
      {mentioned.length > 0 && (
        <Text type="supporting" as="div" aria-live="polite">
          将触发：{mentioned.map((h) => `@${h}`).join(" ")}
        </Text>
      )}
      <HStack justify="end">
        <Button
          type="submit"
          label="发送"
          variant="primary"
          isLoading={sending}
          isDisabled={sending || content.trim().length === 0}
        />
      </HStack>
      </VStack>
    </form>
  );
}
