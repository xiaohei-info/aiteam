import { memo } from 'react'
import type { MouseEvent } from 'react'
import type { Message } from '../../stores/chat'
import { ThinkingBlock } from './ThinkingBlock'
import TextMessage from './TextMessage'
import FileMessage from './FileMessage'
import TodoTaskCard from './TodoTaskCard'
import LocalCitationCard, { LocalContextChip } from './LocalCitationCard'
import { getEmployeeAvatar, renderAvatar } from '../../lib/avatarUtils'
import { collectTodoTaskCards, withToolCallSteps } from '../../lib/todoTaskCard'
import { collectLocalCitationHits } from '../../lib/localDirectoryCitations'

export interface MessageRowProps {
  conversationId: string
  msg: Message
  convAgentName?: string
  agentAvatarUrl?: string | null
  userAvatar: string
  displayContent: string
  isThisStreaming: boolean
  isThinkingPhase: boolean
  onAvatarClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

export const MessageRow = memo(function MessageRow({
  conversationId,
  msg,
  convAgentName,
  agentAvatarUrl,
  userAvatar,
  displayContent,
  isThisStreaming,
  isThinkingPhase,
  onAvatarClick,
}: MessageRowProps) {
  const side = msg.role === 'user' ? 'right' : 'left'

  // 使用员工名称生成头像，而不是emoji
  const avatarContent = msg.role === 'assistant'
    ? getEmployeeAvatar(msg.senderName || convAgentName || '助手', agentAvatarUrl)
    : userAvatar

  const fallbackName = msg.role === 'assistant' ? (msg.senderName || convAgentName || '助手') : userAvatar
  const avatarFallback = fallbackName.trim().slice(0, 1).toUpperCase() || '?'
  const avatar = renderAvatar(avatarContent, avatarFallback)
  const senderName = msg.role === 'assistant' ? (msg.senderName ?? convAgentName) : msg.senderName
  const thinkingSteps = withToolCallSteps(
    msg.thinkingSteps ?? (msg.thinking ? [{ kind: 'reasoning' as const, text: msg.thinking }] : undefined),
    msg.toolCalls,
  )
  const todoCards = msg.role === 'assistant'
    ? collectTodoTaskCards(thinkingSteps, msg.toolCalls)
    : []
  const localCitations = msg.role === 'assistant'
    ? collectLocalCitationHits(thinkingSteps, msg.toolCalls)
    : []

  const localContext = msg.role === 'user' ? msg.localContext : undefined

  if (msg.msgType === 'file' || msg.msgType === 'image') {
    return (
      <FileMessage
        side={side}
        avatar={avatar}
        name={senderName}
        recipientName={msg.recipientName}
        time={msg.time}
        content={msg.content}
        onAvatarClick={onAvatarClick}
      />
    )
  }

  return (
    <TextMessage
      conversationId={conversationId}
      side={side}
      avatar={avatar}
      name={senderName}
      recipientName={msg.recipientName}
      time={msg.time}
      above={
        (thinkingSteps?.length || todoCards.length > 0 || localCitations.length > 0 || localContext)
          ? <>
              {localContext && <LocalContextChip action={localContext} />}
              {thinkingSteps?.length ? (
                <ThinkingBlock steps={thinkingSteps} isStreaming={isThinkingPhase} autoExpand={todoCards.length === 0} />
              ) : null}
              {todoCards.map((card) => <TodoTaskCard card={card} key={msg.id} isActive={isThisStreaming} />)}
              {localCitations.length > 0 && <LocalCitationCard hits={localCitations} isActive={isThisStreaming} />}
            </>
          : undefined
      }
      content={displayContent}
      isStreaming={isThisStreaming}
      attachments={msg.attachments}
      onAvatarClick={onAvatarClick}
    />
  )
})
