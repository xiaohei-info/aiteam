/**
 * A send error belongs to the conversation it happened in. The page keeps one, and shows it only
 * while that conversation is on screen: a failure that returns after the user switched away must not
 * appear under the other conversation, and must still be there when the user comes back.
 */
export interface ConversationSendError {
  conversationId: string
  message: string
}

export function sendErrorFor(error: ConversationSendError | null, conversationId: string): string | null {
  return error && error.conversationId === conversationId ? error.message : null
}

/** Clears the error of one conversation only; another conversation's error stays. */
export function clearSendErrorFor(error: ConversationSendError | null, conversationId: string): ConversationSendError | null {
  return error && error.conversationId === conversationId ? null : error
}
