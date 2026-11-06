/** Reload a view of conversation output whenever a run in that conversation has fully finished. */

export interface SettledRefreshOptions {
  /** Subscribe to the conversation's events; returns the way to unsubscribe. */
  subscribe: (onEvent: (event: { type?: string }) => void) => () => void
  /** Whether a run is still executing. */
  isPrompting: () => Promise<boolean>
  reload: () => Promise<unknown>
  pollMs?: number
  maxPolls?: number
}

/**
 * Agent copies the run's files after it publishes `agent_settled` and only then clears `prompting`,
 * so reloading on the event itself would miss them. A run that never clears it (or a new run that
 * starts right away) still gets a reload once the polls are used up. Failures keep what is on screen.
 */
export function refreshWhenRunsSettle({ subscribe, isPrompting, reload, pollMs = 500, maxPolls = 40 }: SettledRefreshOptions): () => void {
  let closed = false
  let running = false
  let settledAgain = false

  const refresh = async () => {
    if (running) { settledAgain = true; return }
    running = true
    try {
      do {
        settledAgain = false
        for (let poll = 0; poll < maxPolls && !closed && await isPrompting(); poll += 1) {
          await new Promise(resolve => setTimeout(resolve, pollMs))
        }
        if (!closed) await reload()
      } while (settledAgain && !closed)
    } catch {
      // Keep the current list; the next settled run or reopening the view tries again.
    } finally {
      running = false
    }
  }

  const unsubscribe = subscribe(event => {
    if (event.type === 'agent_settled') void refresh()
  })
  return () => {
    closed = true
    unsubscribe()
  }
}
