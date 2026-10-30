/**
 * 点击发送时输入框立即清空；发送失败后决定把内容放回哪里：
 * - composer：仍在同一会话（含 emp_ 升级为真实会话），原样放回输入框；
 * - draft：请求期间切到了别的会话或离开了聊天页，写回发送时那个会话的草稿，回来时恢复；
 * - none：新会话页（会话 ID 为空）发送后已卸载，由页面写回新会话的草稿；
 *   或用户在请求期间又输入了新内容（不覆盖）。失败的消息气泡仍保留原文。
 */
export type ComposerRestoreTarget =
  | { kind: 'composer' }
  | { kind: 'draft'; conversationId: string }
  | { kind: 'none' }

export interface ComposerRestoreState {
  mounted: boolean
  sameConversation: boolean
  composerEmpty: boolean
  /** 发送时所在的会话；emp_ 升级后为真实会话 ID；新会话页为空字符串。 */
  submittedConversationId: string
}

export function composerRestoreTarget(state: ComposerRestoreState): ComposerRestoreTarget {
  if (!state.mounted || !state.sameConversation) {
    return state.submittedConversationId
      ? { kind: 'draft', conversationId: state.submittedConversationId }
      : { kind: 'none' }
  }
  return state.composerEmpty ? { kind: 'composer' } : { kind: 'none' }
}
