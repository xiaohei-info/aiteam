import {
  formatUnreadCount,
  getConversationUnreadCount,
  type ConversationUnreadState,
} from '../../lib/conversationUnread'

/** 单聊、群聊列表共用徽标，与 Tab 使用同一个计数规则。 */
export default function ConversationUnreadBadge({ conversation }: { conversation: ConversationUnreadState }) {
  const count = getConversationUnreadCount(conversation)
  if (count === undefined) {
    return <span className="panel-conv-badge unknown" title="未读数量未提供" aria-label="未读数量未提供">?</span>
  }
  if (count === 0) return null
  return <span className="panel-conv-badge" aria-label={`${count} 条未读消息`}>{formatUnreadCount(count)}</span>
}
