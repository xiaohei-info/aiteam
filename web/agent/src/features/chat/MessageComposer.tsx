/**
 * W-A.2 消息输入器（底部）—— 发消息后起 run（POST /conversations/{id}/runs）触发 AI 处理。
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

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, cn } from "@aiteam/shared/ui";
import { useApiError, useApp } from "../../lib/app-context";
import { sendMessage, startRun } from "./useChatApi";
import { parseMentions } from "../group/MentionComposer";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";

const SKILL_OPTIONS = [
  { id: "writer", label: "写作助手" },
  { id: "code-review", label: "代码审查" },
  { id: "data-analysis", label: "数据分析" },
  { id: "translate", label: "翻译" },
] as const;

const TOAST_TTL_MS = 2500;

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
  const mentionAnchorRef = useRef<HTMLDivElement>(null);
  const skillAnchorRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // 关闭 popover 当点击外部（Esc 由 button toggle / 浏览器默认处理）。
  useEffect(() => {
    if (!mentionOpen && !skillOpen) return;
    function onDocMouseDown(ev: MouseEvent) {
      const target = ev.target as Node;
      if (
        (mentionOpen && mentionAnchorRef.current && !mentionAnchorRef.current.contains(target)) ||
        (skillOpen && skillAnchorRef.current && !skillAnchorRef.current.contains(target))
      ) {
        setMentionOpen(false);
        setSkillOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [mentionOpen, skillOpen]);

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
    if (files.length > 0) {
      setAttachments((prev) => [...prev, ...files]);
    }
    // 清空 value 使同一文件再次可选。
    ev.target.value = "";
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  function insertAtCursor(insert: string) {
    const field = document.getElementById("composer-content") as HTMLTextAreaElement | null;
    if (field) {
      const start = field.selectionStart ?? content.length;
      const end = field.selectionEnd ?? content.length;
      const next = content.slice(0, start) + insert + content.slice(end);
      setContent(next);
      requestAnimationFrame(() => {
        field.focus();
        field.selectionStart = field.selectionEnd = start + insert.length;
      });
    } else {
      setContent((prev) => prev + insert);
    }
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

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = content.trim();
    const attachedNote =
      attachments.length > 0
        ? `\n\n[附件: ${attachments.map((f) => f.name).join(", ")}]`
        : "";
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(client, conversationId, { content: text + attachedNote });
      // 起 run 触发 AI 处理，时间线产出 BusinessTimelineEvent。
      await startRun(client, conversationId);
      setContent("");
      setAttachments([]);
      onSent();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="flex flex-col gap-xs border-t border-gold/15 p-md" onSubmit={handleSubmit}>
      {toast && (
        <div role="status" className="mb-xs rounded-md bg-surface-raised px-sm py-xs text-xs text-text-primary">
          {toast}
        </div>
      )}

      {/* 工具栏：附件 / @提及 / 技能市场入口 / 截图 */} 
      <div className="flex items-center gap-xs">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="附件上传"
          title="附件上传"
          onClick={openFilePicker}
          disabled={sending}
        >
          📎
        </Button>

        <div ref={mentionAnchorRef} className="relative">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="召唤其他智能体"
            title="@提及：召唤其他智能体"
            aria-expanded={mentionOpen}
            onClick={() => setMentionOpen((v) => !v)}
            disabled={sending}
          >
            🤖
          </Button>
          {mentionOpen && (
            <Popover>
              {roster.length === 0 ? (
                <div className="px-sm py-xs text-xs text-text-muted">暂无可召唤的智能体</div>
              ) : (
                <ul className="flex flex-col">
                  {roster.map((p) => {
                    const handle = p.display_name;
                    return (
                      <li key={p.employee_id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-md px-sm py-xs text-left text-sm text-text-primary hover:bg-surface-raised"
                          onClick={() => pickHandle(handle)}
                        >
                          <span>@{handle}</span>
                          <span className="text-xs text-text-muted">点击召唤</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Popover>
          )}
        </div>

        <div ref={skillAnchorRef} className="relative">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="技能市场入口"
            title="/：使用技能"
            aria-expanded={skillOpen}
            onClick={() => setSkillOpen((v) => !v)}
            disabled={sending}
          >
            ⚡
          </Button>
          {skillOpen && (
            <Popover>
              <ul className="flex flex-col">
                {SKILL_OPTIONS.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-md px-sm py-xs text-left text-sm text-text-primary hover:bg-surface-raised"
                      onClick={() => pickSkill(s.label)}
                    >
                      <span>/{s.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Popover>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="截图工具"
          title="截图工具"
          onClick={handleScreenshot}
          disabled={sending}
        >
          📷
        </Button>

        <span className="flex-1" />
      </div>

      <textarea
        id="composer-content"
        className="resize-y rounded-md border border-gold/20 bg-surface px-md py-sm text-sm text-text-primary outline-none focus:ring-2 focus:ring-gold"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="输入消息，@ 召唤智能体，/ 使用技能…"
        rows={2}
        disabled={sending}
        aria-label="消息内容"
      />

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-xs">
          {attachments.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="inline-flex items-center gap-xs rounded-md border border-gold/20 bg-surface px-sm py-xs text-xs text-text-primary"
            >
              📎 {f.name}
              <button
                type="button"
                aria-label={`移除附件 ${f.name}`}
                className="text-text-muted hover:text-text-primary"
                onClick={() => removeAttachment(i)}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {mentioned.length > 0 && (
        <div className="px-xs text-xs text-text-secondary" aria-live="polite">
          已 @提及：{mentioned.map((h) => `@${h}`).join(" ")}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        aria-hidden="true"
      />

      {error && <div className="text-xs text-danger">{error}</div>}
      <Button type="submit" className="self-end" disabled={sending || (content.trim().length === 0 && attachments.length === 0)}>
        {sending ? "发送中…" : "发送"}
      </Button>
    </form>
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

interface PopoverProps {
  children: React.ReactNode;
}

/** 工具按钮弹层：玻璃质感 + 圆角边框。相对父级绝对定位；复用 design tokens。 */
function Popover({ children }: PopoverProps): React.ReactNode {
  return (
    <div className="glass absolute bottom-full left-0 z-[1300] mb-xs min-w-[12rem] overflow-hidden p-xs">
      {children}
    </div>
  );
}
