/**
 * W-A.2 消息输入器（底部）——提交 prompt 后由 Agent 异步处理。
 *
 * 工具栏（对齐 demo AI-Team-Demo.html:1166-1171 + #307 验收）：
 *   📎 附件  ·  @ @提及（召唤智能体） ·  / 技能市场入口 ·  📷 截图工具
 * 右侧：发送。
 *
 * AITEAM-688：runtime/model 是部署级配置，前端不再提供模型选择入口。
 *
 * 复用工种：
 *   - 群聊 MentionComposer.parseMentions 解析已输入 @提及（口径与后端一致）。
 *   - listLoadedExperts（GET /api/agent/grants/experts）提供 @提及 roster 真实数据源。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  ChatComposer,
  ChatComposerInput,
  type ChatComposerInputHandle,
} from "@astryxdesign/core/Chat";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Popover } from "@astryxdesign/core/Popover";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApiError, useApp } from "../../lib/app-context";
import { ApiError } from "@aiteam/shared/api-client";
import { AgentIcon, AttachmentIcon, ScreenshotIcon, SkillIcon } from "@aiteam/shared/theme";
import { abortPrompt, deleteAttachment, submitPrompt, uploadAttachment, type LocalFile } from "./useChatApi";
import { parseMentions } from "../group/MentionComposer";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";

const SKILL_OPTIONS = [
  { id: "writer", label: "写作助手" },
  { id: "code-review", label: "代码审查" },
  { id: "data-analysis", label: "数据分析" },
  { id: "translate", label: "翻译" },
] as const;

const TOAST_TTL_MS = 2500;

export type PendingSubmission = { key: string; text: string; uploaded: LocalFile[]; uploadsComplete: boolean; promptAttempted: boolean };

export function isIdempotencyUnknownError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "idempotency_unknown";
}

export function resetPendingSubmissionKey(pending: PendingSubmission): PendingSubmission {
  return { ...pending, key: crypto.randomUUID(), promptAttempted: false };
}

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
  const [attachments, setAttachments] = useState<File[]>([]);
  const [roster, setRoster] = useState<LoadedExpertProjection[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [skillOpen, setSkillOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<ChatComposerInputHandle>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSubmission = useRef<PendingSubmission | null>(null);

  // roster 真实数据源（grants/experts：本地已装载/已授权专家投影）。
  useEffect(() => {
    let cancelled = false;
    listLoadedExperts(client)
      .then((items) => {
        if (!cancelled) setRoster(items.filter((p) => !p.revoked));
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_TTL_MS);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [toast]);

  const visibleHandles = useMemo(() => new Set(footerHandles(roster)), [roster]);
  const mentioned = useMemo(() => parseMentions(content, visibleHandles), [content, visibleHandles]);

  function showToast(message: string) {
    setToast(message);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleFileChange(ev: ChangeEvent<HTMLInputElement>) {
    const files = ev.target.files ? Array.from(ev.target.files) : [];
    const accepted = files.filter((file) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type));
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    if (accepted.length !== files.length) showToast("仅支持 PNG、JPEG、WEBP 或 GIF 图片");
    // 清空 value 使同一文件再次可选。
    ev.target.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  function insertAtCursor(insert: string) {
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertText(insert);
    setContent(input.getValue());
  }

  function pickHandle(handle: string) {
    insertAtCursor(`@${handle} `);
    setMentionOpen(false);
  }

  function pickSkill(label: string) {
    insertAtCursor(`/${label} `);
    setSkillOpen(false);
  }

  function handleScreenshot() {
    showToast("截图工具即将上线");
  }

  async function submitCurrentContent(): Promise<void> {
    const text = content.trim();
    const attachedNote =
      attachments.length > 0
        ? `\n\n[附件: ${attachments.map((f) => f.name).join(", ")}]`
        : "";
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setError(null);
    const pending = pendingSubmission.current ?? { key: crypto.randomUUID(), text: text + attachedNote, uploaded: [], uploadsComplete: false, promptAttempted: false };
    pendingSubmission.current = pending;
    try {
      // Upload bytes to Agent storage first; Manager never sees attachment content.
      if (!pending.uploadsComplete) {
        for (const file of attachments) pending.uploaded.push(await uploadAttachment(client, conversationId, file));
        pending.uploadsComplete = true;
      }
      // Keep the key and local IDs stable: a lost response may mean the Agent accepted the prompt.
      pending.promptAttempted = true;
      await submitPrompt(client, conversationId, { text: pending.text, attachment_ids: pending.uploaded.map((file) => file.id) }, pending.key);
      pendingSubmission.current = null;
      setContent("");
      setAttachments([]);
      onSent();
    } catch (err) {
      if (!pending.promptAttempted) {
        // Upload failed before any prompt attempt; these IDs are definitely orphaned.
        await Promise.all(pending.uploaded.map((file) => deleteAttachment(client, conversationId, file.id).catch(() => undefined)));
        pendingSubmission.current = null;
      } else if (isIdempotencyUnknownError(err)) {
        // Unknown execution may have been accepted: preserve uploads/text, but require a new explicit key.
        pendingSubmission.current = resetPendingSubmissionKey(pending);
        setError("执行状态未知，请确认对话未重复执行后点击发送，以新的幂等键重试；已保留附件。");
      }
      if (!isIdempotencyUnknownError(err)) setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function abortCurrentPrompt(): Promise<void> {
    try {
      await abortPrompt(client, conversationId);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  function handleInputKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void submitCurrentContent();
  }

  const toolbarActions = (
    <HStack gap={1} role="group" aria-label="消息工具">
      <Button
        label="附件上传"
        tooltip="附件上传"
        size="sm"
        variant="ghost"
        icon={<Icon icon={AttachmentIcon} size="sm" />}
        isIconOnly
        onClick={openFilePicker}
        isDisabled={sending}
      />

      <Popover
        isOpen={mentionOpen}
        onOpenChange={setMentionOpen}
        label="召唤其他智能体"
        placement="above"
        width={240}
        hasAutoFocus={false}
        content={
          roster.length === 0 ? (
            <Text type="supporting">暂无可召唤的智能体</Text>
          ) : (
            <VStack gap={1}>
              {roster.map((p) => {
                const handle = p.display_name;
                return (
                  <Button
                    key={p.employee_id}
                    label={`@${handle}（点击召唤）`}
                    variant="ghost"
                    size="sm"
                    onClick={() => pickHandle(handle)}
                  />
                );
              })}
            </VStack>
          )
        }
      >
        <Button
          label="召唤其他智能体"
          tooltip="@提及：召唤其他智能体"
          size="sm"
          variant="ghost"
          icon={<Icon icon={AgentIcon} size="sm" />}
          isIconOnly
          isDisabled={sending}
        />
      </Popover>

      <Popover
        isOpen={skillOpen}
        onOpenChange={setSkillOpen}
        label="选择技能"
        placement="above"
        width={240}
        content={
          <VStack gap={1}>
            {SKILL_OPTIONS.map((skill) => (
              <Button
                key={skill.id}
                label={`/${skill.label}`}
                variant="ghost"
                size="sm"
                onClick={() => pickSkill(skill.label)}
              />
            ))}
          </VStack>
        }
      >
        <Button
          label="技能市场入口"
          tooltip="/：使用技能"
          size="sm"
          variant="ghost"
          icon={<Icon icon={SkillIcon} size="sm" />}
          isIconOnly
          isDisabled={sending}
        />
      </Popover>

      <Button
        label="截图工具"
        tooltip="截图工具"
        size="sm"
        variant="ghost"
        icon={<Icon icon={ScreenshotIcon} size="sm" />}
        isIconOnly
        onClick={handleScreenshot}
        isDisabled={sending}
      />
    </HStack>
  );

  return (
    <VStack gap={1} padding={4}>
      {toast && <Banner status="info" title={toast} />}
      <ChatComposer
        value={content}
        onChange={setContent}
        onSubmit={() => undefined}
        isDisabled={sending}
        placeholder="输入消息，@ 召唤智能体，/ 使用技能…"
        status={error ? { type: "error", message: error } : undefined}
        drawer={
          attachments.length > 0 || mentioned.length > 0 ? (
            <VStack gap={1} padding={1}>
              {attachments.length > 0 && (
                <HStack gap={1} wrap="wrap">
                  {attachments.map((f, i) => (
                    <HStack
                      key={`${f.name}-${i}`}
                      gap={1}
                      align="center"
                    >
                      <Badge label={f.name} icon={<Icon icon={AttachmentIcon} size="xsm" />} />
                      <Button
                        label={`移除附件 ${f.name}`}
                        tooltip={`移除附件 ${f.name}`}
                        variant="ghost"
                        size="sm"
                        isIconOnly
                        icon={<Icon icon="close" size="xsm" />}
                        aria-label={`移除附件 ${f.name}`}
                        onClick={() => removeAttachment(i)}
                      />
                    </HStack>
                  ))}
                </HStack>
              )}
              {mentioned.length > 0 && (
                <Text type="supporting" as="div" aria-live="polite">
                  已 @提及：{mentioned.map((h) => `@${h}`).join(" ")}
                </Text>
              )}
            </VStack>
          ) : undefined
        }
        footerActions={toolbarActions}
        input={
          <ChatComposerInput
            handleRef={composerInputRef}
            label="消息内容"
            value={content}
            onChange={setContent}
            onSubmit={() => undefined}
            onKeyDownCapture={handleInputKeyDownCapture}
            placeholder="输入消息，@ 召唤智能体，/ 使用技能…"
            isDisabled={sending}
          />
        }
        sendButton={
          sending ? (
            <Button label="停止" variant="secondary" onClick={() => void abortCurrentPrompt()} />
          ) : (
            <Button
              label="发送"
              variant="primary"
              isDisabled={!content.trim() && attachments.length === 0}
              onClick={() => void submitCurrentContent()}
            />
          )
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </VStack>
  );
}

/** 把 roster 投影成 @提及 handle 集合。handle 取 display_name（与 MentionComposer+GroupPage 口径一致）。 */
function footerHandles(roster: LoadedExpertProjection[]): string[] {
  const seen = new Set<string>();
  for (const p of roster) {
    if (p.display_name) seen.add(p.display_name);
  }
  return [...seen];
}
