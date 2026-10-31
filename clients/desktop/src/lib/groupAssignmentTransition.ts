interface GroupAssignmentMessage {
  id: string
  role: 'user' | 'assistant'
  _pending?: boolean
}

export function shouldShowGroupAssignmentTransition(
  generating: boolean,
  messages: GroupAssignmentMessage[],
  streamingMessageIds: ReadonlySet<string>,
): boolean {
  if (!generating) return false

  return !messages.some((message) => (
    message.role === 'assistant'
    && message._pending === true
    && streamingMessageIds.has(message.id)
  ))
}
