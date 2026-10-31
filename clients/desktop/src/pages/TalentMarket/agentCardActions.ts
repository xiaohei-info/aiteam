export interface AgentCardActionHandlers {
  onDetail: () => void
  onRecruit: () => void
  onStartChat: () => void
}

export function runAgentCardAction(
  action: 'detail' | 'primary',
  canStartChat: boolean,
  handlers: AgentCardActionHandlers,
): void {
  if (action === 'detail') {
    handlers.onDetail()
    return
  }
  if (canStartChat) {
    handlers.onStartChat()
    return
  }
  handlers.onRecruit()
}
