/**
 * 回复失败提示条：一句用户能看懂的原因 +「查看详情」（原始报错，可复制给我们排查）+ 可选「重试」。
 * 只负责展示；原因归类见 lib/replyFailure.ts，重试由页面决定能否提供。
 */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, RotateCcw, TriangleAlert } from 'lucide-react'
import type { ReplyFailure } from '../../lib/replyFailure'
import './ReplyFailureNotice.css'

interface ReplyFailureNoticeProps {
  failure: ReplyFailure
  /** 页面能重发触发这次执行的消息时提供。 */
  onRetry?: () => void
}

export default function ReplyFailureNotice({ failure, onRetry }: ReplyFailureNoticeProps) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = () => {
    if (!failure.detail) return
    navigator.clipboard.writeText(failure.detail).then(() => setCopied(true), () => setCopied(false))
  }

  return (
    <div className="rfn" role="alert">
      <div className="rfn-head">
        <TriangleAlert size={14} strokeWidth={1.9} aria-hidden />
        <span className="rfn-summary">{failure.summary}</span>
        <span className="rfn-actions">
          {failure.detail && (
            <button type="button" className="rfn-link" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}查看详情
            </button>
          )}
          {onRetry && (
            <button type="button" className="rfn-button" onClick={onRetry}>
              <RotateCcw size={12} />重试
            </button>
          )}
        </span>
      </div>
      {expanded && failure.detail && (
        <div className="rfn-detail">
          <code>{failure.detail}</code>
          <button type="button" className="rfn-link" onClick={copy} aria-label="复制报错原文">
            {copied ? <><Check size={12} />已复制</> : <><Copy size={12} />复制</>}
          </button>
        </div>
      )}
    </div>
  )
}
