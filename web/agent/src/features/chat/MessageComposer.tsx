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
 *   - 统一解析群聊 @提及（口径与后端一致）。
 *   - 私聊自行读取授权 roster；群聊由父级传入方案裁剪后的 roster。
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
  type ChatComposerToken,
  type ChatComposerTrigger,
} from "@astryxdesign/core/Chat";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Popover } from "@astryxdesign/core/Popover";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createStaticSource } from "@astryxdesign/core/Typeahead";
import { useApiError, useApp } from "../../lib/app-context";
import { ApiError } from "@aiteam/shared/api-client";
import { AgentIcon, AttachmentIcon, ScreenshotIcon, SkillIcon } from "@aiteam/shared/theme";
import { abortPrompt, attachmentMimeType, deleteAttachment, isSupportedAttachmentMime, makeIdempotencyKey, submitPrompt, uploadAttachment, type Conversation, type LocalFile } from "./useChatApi";
import { ConversationPermissionControl } from "./ConversationPermissionControl";
import { ConversationContextHud } from "./ConversationContextHud";
import { parseMentions } from "../group/mention";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";

const SKILL_OPTIONS = [
  { id: "writer", label: "写作助手" },
  { id: "code-review", label: "代码审查" },
  { id: "data-analysis", label: "数据分析" },
  { id: "translate", label: "翻译" },
] as const;

const TOAST_TTL_MS = 2500;

type MentionItem = { id: string; label: string; auxiliaryData: LoadedExpertProjection };

export type PendingSubmission = {
  key: string;
  text: string;
  uploaded: LocalFile[];
  uploadsComplete: boolean;
  promptAttempted: boolean;
  conversationId?: string;
  inputSignature?: string;
};

export function isIdempotencyUnknownError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "idempotency_unknown";
}

export function resetPendingSubmissionKey(pending: PendingSubmission): PendingSubmission {
  return { ...pending, key: makeIdempotencyKey(), promptAttempted: false };
}

export interface MessageComposerProps {
  conversationId: string;
  isPrompting: boolean;
  onPromptingChange: (prompting: boolean) => void;
  onSent: () => void;
  refreshSignal?: number;
  /** Group conversations pass their authorized solution roster; private chat keeps the local roster lookup. */
  mentionRoster?: LoadedExpertProjection[];
  /** The owning conversation enables the shared permission control beside Send. */
  conversation?: Conversation;
  onConversationChanged?: (conversation: Conversation) => void;
}

export function MessageComposer({ conversationId, isPrompting, onPromptingChange, onSent, refreshSignal = 0, mentionRoster, conversation, onConversationChanged }: MessageComposerProps) {
  const { client } = useApp();
  const toMessage = useApiError();
  const [content, setContent] = useState("");
  const [submitting, setSending] = useState(false);
  const sending = submitting || isPrompting;
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
  const previousConversationId = useRef(conversationId);
  const submissionGeneration = useRef(0);

  useEffect(() => {
    if (previousConversationId.current === conversationId) return;
    previousConversationId.current = conversationId;
    submissionGeneration.current += 1;
    pendingSubmission.current = null;
    setSending(false);
    onPromptingChange(false);
    setContent("");
    setAttachments([]);
    setError(null);
    setMentionOpen(false);
    setSkillOpen(false);
  }, [conversationId, onPromptingChange]);

  // Private chat reads the full local roster. Group chat supplies the solution-scoped roster
  // so the composer never offers an employee outside the current conversation.
  useEffect(() => {
    if (mentionRoster !== undefined) return;
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
  }, [client, mentionRoster]);

  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_TTL_MS);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [toast]);

  const activeRoster = mentionRoster ?? roster;
  const visibleHandles = useMemo(() => new Set(footerHandles(activeRoster)), [activeRoster]);
  const mentionAliases = useMemo(() => {
    const aliases = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const expert of activeRoster) {
      const name = typeof expert.display_name === "string" ? expert.display_name.trim() : "";
      if (!name) continue;
      if (aliases.has(name) && aliases.get(name) !== expert.handle) ambiguous.add(name);
      else if (!ambiguous.has(name)) aliases.set(name, expert.handle);
    }
    for (const name of ambiguous) aliases.delete(name);
    return aliases;
  }, [activeRoster]);
  const mentioned = useMemo(() => parseMentions(content, visibleHandles, mentionAliases), [content, mentionAliases, visibleHandles]);
  const mentionByHandle = useMemo(
    () => new Map(activeRoster.map((expert) => [expert.handle, expert] as const)),
    [activeRoster],
  );
  const mentionItems = useMemo<MentionItem[]>(
    () => activeRoster.map((expert) => ({
      id: expert.employee_id,
      label: mentionDisplayName(expert),
      auxiliaryData: expert,
    })),
    [activeRoster],
  );
  const mentionTriggers = useMemo<ChatComposerTrigger[]>(() => {
    if (mentionRoster === undefined || mentionItems.length === 0) return [];
    return [{
      character: "@",
      searchSource: createStaticSource(mentionItems),
      renderItem: (item) => <span>{item.label}</span>,
      onSelect: (item) => mentionToken(item.auxiliaryData as LoadedExpertProjection),
      emptySearchResultsText: "没有匹配的群成员",
      loadingText: "加载群成员…",
      menuLabel: "可 @ 的群成员",
    }];
  }, [mentionItems, mentionRoster]);

  function showToast(message: string) {
    setToast(message);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleFileChange(ev: ChangeEvent<HTMLInputElement>) {
    const files = ev.target.files ? Array.from(ev.target.files) : [];
    const accepted = files.filter((file) => file.size <= 5 * 1024 * 1024 && isSupportedAttachmentMime(attachmentMimeType(file)));
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    if (accepted.length !== files.length) showToast("仅支持受支持的本地文件，单个文件不超过 5 MiB");
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

  function insertMention(expert: LoadedExpertProjection) {
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertToken(mentionToken(expert));
    setContent(input.getValue());
  }

  // GroupExpertRoster uses the same composer as private chat and only emits a
  // local insertion event; prompt submission remains in this shared component.
  useEffect(() => {
    const onAppendMention = (event: Event) => {
      if (mentionRoster === undefined) return;
      const handle = (event as CustomEvent<string>).detail;
      const expert = typeof handle === "string" ? mentionByHandle.get(handle) : undefined;
      if (expert) insertMention(expert);
    };
    window.addEventListener("group:append-mention", onAppendMention);
    return () => window.removeEventListener("group:append-mention", onAppendMention);
  }, [mentionByHandle, mentionRoster]);

  function pickHandle(handle: string) {
    const expert = mentionByHandle.get(handle);
    if (expert) insertMention(expert);
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
    const inputSignature = JSON.stringify({ conversationId, text: text + attachedNote, files: attachments.map((file) => `${file.name}:${file.size}:${file.lastModified}`) });
    const existing = pendingSubmission.current;
    const pending = existing
      && existing.conversationId === conversationId
      && existing.inputSignature === inputSignature
      ? existing
      : { key: makeIdempotencyKey(), text: text + attachedNote, uploaded: [], uploadsComplete: false, promptAttempted: false, conversationId, inputSignature };
    pendingSubmission.current = pending;
    const generation = submissionGeneration.current;
    const isCurrent = () => generation === submissionGeneration.current && pendingSubmission.current === pending;
    try {
      // Upload bytes to Agent storage first; Manager never sees attachment content.
      if (!pending.uploadsComplete) {
        for (const file of attachments) pending.uploaded.push(await uploadAttachment(client, conversationId, file));
        pending.uploadsComplete = true;
      }
      if (!isCurrent()) {
        await Promise.all(pending.uploaded.map((file) => deleteAttachment(client, conversationId, file.id).catch(() => undefined)));
        return;
      }
      // Keep the key and local IDs stable: a lost response may mean the Agent accepted the prompt.
      pending.promptAttempted = true;
      onPromptingChange(true);
      await submitPrompt(client, conversationId, {
        text: pending.text,
        attachment_ids: pending.uploaded.map((file) => file.id),
        ...(mentionRoster !== undefined && mentioned.length > 0 ? { mentions: mentioned } : {}),
      }, pending.key);
      if (!isCurrent()) return;
      pendingSubmission.current = null;
      setContent("");
      setAttachments([]);
      onSent();
    } catch (err) {
      if (!isCurrent()) {
        if (!pending.promptAttempted) {
          await Promise.all(pending.uploaded.map((file) => deleteAttachment(client, conversationId, file.id).catch(() => undefined)));
        }
        return;
      }
      onPromptingChange(false);
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
      if (generation === submissionGeneration.current) setSending(false);
    }
  }

  async function abortCurrentPrompt(): Promise<void> {
    try {
      await abortPrompt(client, conversationId);
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
      onPromptingChange(false);
    }
  }

  function handleInputKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) {
      event.stopPropagation();
      return;
    }
    // ChatComposerInput owns trigger-menu keyboard navigation. Its internal
    // handler runs after capture; let it consume Enter when an option exists.
    if (hasActiveTriggerOption(event.target)) return;
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
          activeRoster.length === 0 ? (
            <Text type="supporting">暂无可召唤的智能体</Text>
          ) : (
            <VStack gap={1}>
              {activeRoster.map((p) => (
                <Button
                  key={p.employee_id}
                  label={`@${p.display_name || p.handle}（点击召唤）`}
                  variant="ghost"
                  size="sm"
                  onClick={() => pickHandle(p.handle)}
                />
              ))}
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
      {isPrompting ? <Text type="supporting" role="status" aria-live="polite">执行中</Text> : null}
      <ChatComposer
        value={content}
        onChange={setContent}
        onSubmit={() => undefined}
        isDisabled={false}
        placeholder="输入消息，@ 召唤智能体，/ 使用技能…"
        status={error ? { type: "error", message: error } : undefined}
        headerContext={<ConversationContextHud client={client} conversationId={conversationId} refreshSignal={refreshSignal} isPrompting={isPrompting} />}
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
                  已 @提及：{mentioned.map((handle) => `@${mentionDisplayName(mentionByHandle.get(handle))}`).join(" ")}
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
            triggers={mentionTriggers}
            debounceMs={0}
            onChange={setContent}
            onSubmit={() => undefined}
            onKeyDownCapture={handleInputKeyDownCapture}
            placeholder="输入消息，@ 召唤智能体，/ 使用技能…"
            isDisabled={sending}
          />
        }
        sendButton={
          <HStack gap={1} align="center">
            {conversation && onConversationChanged ? (
              <ConversationPermissionControl client={client} conversation={conversation} onChanged={onConversationChanged} />
            ) : null}
            {isPrompting ? (
              <Button label="终止" variant="secondary" onClick={() => void abortCurrentPrompt()} />
            ) : (
              <Button
                label="发送"
                variant="primary"
                isLoading={submitting}
                isDisabled={submitting || !content.trim() && attachments.length === 0}
                onClick={() => void submitCurrentContent()}
              />
            )}
          </HStack>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.markdown,.json,.csv,.css,.html,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.sh,.sql,.yaml,.yml,.xml,.doc,.docx,.ppt,.pptx"
        hidden
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </VStack>
  );
}

/** 把 roster 投影成 @提及 handle 集合；delegation 只接受 Agent 投影的 stable handle。 */
export function footerHandles(roster: LoadedExpertProjection[]): string[] {
  const seen = new Set<string>();
  for (const p of roster) {
    if (p.handle) seen.add(p.handle);
  }
  return [...seen];
}

function mentionDisplayName(expert: LoadedExpertProjection | undefined): string {
  const name = expert?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : expert?.handle ?? "群成员";
}

function mentionToken(expert: LoadedExpertProjection): ChatComposerToken {
  const displayName = mentionDisplayName(expert);
  return {
    value: `@${displayName}`,
    render: () => <span aria-label={`@${displayName}`}>@{displayName}</span>,
  };
}

function hasActiveTriggerOption(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable = target.closest('[contenteditable="true"]');
  if (!editable || editable.getAttribute("aria-expanded") !== "true") return false;
  const activeId = editable.getAttribute("aria-activedescendant");
  return Boolean(activeId && document.getElementById(activeId));
}
