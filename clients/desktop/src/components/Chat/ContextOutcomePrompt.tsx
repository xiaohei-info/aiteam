import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, RotateCcw, X } from 'lucide-react'
import type { Message } from '../../stores/chat'
import type { ContextResetController } from '../../hooks/useContextReset'
import {
  emptyOutcomeDraft, MAX_OUTCOME_NOTE_CHARS, OUTCOME_REASONS, outcomeEvaluation, shouldShowOutcomePrompt, type ContextOutcomeDraft,
} from '../../lib/contextOutcome'
import { ContextResetExplainDialog } from './ContextResetExplainDialog'

interface ContextOutcomePromptProps {
  conversationId: string
  // 当前上下文段的消息(最后一条分隔线之后)。
  segment: ReadonlyArray<Pick<Message, 'role' | '_pending'>>
  // 本轮回复生成中(含排队消息)时不出现,结束后才能结束本段。
  generating: boolean
  // 与工具栏「开启新上下文」共用的重置流程;顶部提示和记忆失败确认框由页面渲染。
  reset: ContextResetController
}

/** 「未解决」的原因标签、备注和待跟进;提示条和修改评估共用。 */
export function OutcomeReasonFields({ draft, disabled, onChange }: {
  draft: ContextOutcomeDraft
  disabled?: boolean
  onChange: (draft: ContextOutcomeDraft) => void
}) {
  const toggleReason = (reason: ContextOutcomeDraft['reasons'][number]) => onChange({
    ...draft,
    reasons: draft.reasons.includes(reason) ? draft.reasons.filter((item) => item !== reason) : [...draft.reasons, reason],
  })
  return (
    <div className="chat-outcome-fields">
      <div className="chat-outcome-reasons" role="group" aria-label="未解决原因（可选）">
        {OUTCOME_REASONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="chat-outcome-chip"
            aria-pressed={draft.reasons.includes(value)}
            disabled={disabled}
            onClick={() => toggleReason(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        className="chat-outcome-note"
        aria-label="备注（选填）"
        placeholder="备注（选填）"
        rows={2}
        maxLength={MAX_OUTCOME_NOTE_CHARS}
        value={draft.note}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, note: event.target.value })}
      />
      <label className="chat-outcome-follow-up">
        <input
          type="checkbox"
          checked={draft.followUp}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, followUp: event.target.checked })}
        />
        <span>保留为待跟进事项</span>
      </label>
    </div>
  )
}

/**
 * 回复结束后输入框上方的「解决了吗」提示条:点「已解决」或「未解决」都会结束本段、记录结果并开启新上下文。
 * 不想评估时用输入框工具栏的「开启新上下文」。关掉后到下一次回复结束前不再出现。
 */
export function ContextOutcomePrompt({ conversationId, segment, generating, reset }: ContextOutcomePromptProps) {
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<ContextOutcomeDraft>(() => emptyOutcomeDraft('unresolved'))
  const [explaining, setExplaining] = useState(false)

  useEffect(() => {
    setDismissed(false); setExpanded(false); setDraft(emptyOutcomeDraft('unresolved'))
  }, [conversationId])
  // 新一轮回复开始:它结束后提示条重新出现。
  useEffect(() => {
    if (generating) setDismissed(false)
  }, [generating])
  // 任一入口完成重置(含工具栏不评估的重置):本段已结束,收起提示条。
  useEffect(() => {
    if (reset.completedCount === 0) return
    setDismissed(true); setExpanded(false); setDraft(emptyOutcomeDraft('unresolved'))
  }, [reset.completedCount])

  const submit = (submitted: ContextOutcomeDraft) => { void reset.run('outcome', outcomeEvaluation(submitted), false) }
  const resetting = reset.resetting === 'outcome'

  const visible = resetting || shouldShowOutcomePrompt({ segment, generating, dismissed })
  const busy = reset.resetting !== null || generating

  return (
    <>
      {visible && (
        <div className="chat-outcome-prompt" role="region" aria-label="这个问题解决了吗">
          <div className="chat-outcome-prompt-row">
            <span className="chat-outcome-prompt-question">这个问题解决了吗？</span>
            <button
              type="button"
              className="chat-outcome-btn resolved"
              disabled={busy}
              title="记为已解决，并开启新上下文"
              onClick={() => submit(emptyOutcomeDraft('resolved'))}
            >
              <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
              <span>已解决</span>
            </button>
            <button
              type="button"
              className="chat-outcome-btn unresolved"
              disabled={busy}
              aria-expanded={expanded}
              title="选择原因（可跳过），记为未解决并开启新上下文"
              onClick={() => setExpanded((open) => !open)}
            >
              <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              <span>未解决</span>
            </button>
            {/* 感叹号跟在提示语后面，窄列里随提示语一起换到第二行。 */}
            <span className="chat-outcome-prompt-hint-group">
              <span className="chat-outcome-prompt-hint" title={resetting ? undefined : '选择后将开启新上下文，历史消息保留'}>
                {resetting ? '正在开启新上下文…' : '选择后将开启新上下文，历史消息保留'}
              </span>
              <button
                type="button"
                className="chat-outcome-prompt-info"
                aria-label="开启新上下文是什么意思"
                aria-haspopup="dialog"
                title="开启新上下文是什么意思？"
                onClick={() => setExplaining(true)}
              >
                <CircleAlert size={14} aria-hidden="true" />
              </button>
            </span>
            <button
              type="button"
              className="chat-outcome-prompt-close"
              aria-label="关闭提示"
              title="关闭，下次回复结束后再提示"
              disabled={resetting}
              onClick={() => { setDismissed(true); setExpanded(false) }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {expanded && (
            <div
              className="chat-outcome-panel"
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false) } }}
            >
              <p className="chat-outcome-panel-title">这段对话哪里没解决？<span>（可跳过）</span></p>
              <OutcomeReasonFields draft={draft} disabled={busy} onChange={setDraft} />
              <footer>
                <button type="button" className="chat-outcome-text-btn" disabled={busy} onClick={() => setExpanded(false)}>取消</button>
                <button type="button" className="chat-outcome-text-btn" disabled={busy} onClick={() => submit(emptyOutcomeDraft('unresolved'))}>跳过</button>
                <button type="button" className="chat-outcome-submit" disabled={busy} onClick={() => submit(draft)}>
                  记为未解决并开启
                </button>
              </footer>
            </div>
          )}
        </div>
      )}
      {explaining && <ContextResetExplainDialog onClose={() => setExplaining(false)} />}
    </>
  )
}
