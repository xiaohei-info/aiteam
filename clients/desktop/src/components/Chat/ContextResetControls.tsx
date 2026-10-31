import { createPortal } from 'react-dom'
import { MessageSquarePlus } from 'lucide-react'
import type { ContextResetController } from '../../hooks/useContextReset'
import { confirmationReasonText } from '../../lib/contextResetMemory'
import { ChatDialog } from './ChatDialog'

/** 输入框工具栏上的「开启新上下文」:不评估本段,分隔线显示「未评估」,7 天内仍可在分隔线上补评。 */
export function ContextResetToolButton({ reset, generating, hasContext }: {
  reset: ContextResetController
  generating: boolean
  // 当前上下文段还没有消息时(刚开启过)无需再开。
  hasContext: boolean
}) {
  const disabled = generating || reset.resetting !== null || !hasContext
  const title = generating
    ? '本轮回复结束后才能开启新上下文'
    : !hasContext ? '当前已是新上下文' : '开启新上下文（不评估）：清空模型上下文并保存关键记忆，历史消息保留'
  return (
    <button
      type="button"
      className="chat-tool-btn"
      title={title}
      aria-label="开启新上下文（不评估）"
      disabled={disabled}
      onClick={() => { void reset.run('plain', null, false) }}
    >
      {reset.resetting === 'plain'
        ? <span className="chat-tool-btn-spinner" aria-hidden="true" />
        : <MessageSquarePlus size={16} strokeWidth={1.8} aria-hidden="true" />}
    </button>
  )
}

/** 重置结束后的顶部提示,以及记忆保存失败时的确认框;提示条和工具栏共用。 */
export function ContextResetFeedback({ reset, generating }: { reset: ContextResetController; generating: boolean }) {
  const { notice, pending, resetting } = reset
  return (
    <>
      {/* 渲染到 body：聊天页是独立层叠上下文，留在原处会被应用顶栏盖住。 */}
      {notice && createPortal(
        <div key={notice.id} className={`chat-context-reset-toast ${notice.tone}`} role="status">
          {notice.text}
        </div>,
        document.body,
      )}
      {pending && (
        <ChatDialog title="记忆保存失败" onClose={() => { if (!resetting) reset.cancelPending() }}>
          <p className="chat-tools-note">
            记忆保存失败（{confirmationReasonText(pending.result)}），当前上下文已保留。
            仍要开启新上下文吗？继续后，这段对话的记忆不会保存{pending.evaluation ? '，结果评估照常记录' : ''}。
          </p>
          <footer>
            <button type="button" disabled={resetting !== null} onClick={reset.cancelPending}>取消</button>
            <button type="button" disabled={resetting !== null || generating} onClick={reset.confirmPending}>
              {resetting ? '正在开启…' : '不保存记忆，继续开启'}
            </button>
          </footer>
        </ChatDialog>
      )}
    </>
  )
}
