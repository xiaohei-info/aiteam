export interface HistorySearchRequestDetail {
  initialQuery?: string
}

export const HISTORY_SEARCH_REQUEST_EVENT = 'aifred:history-search-request'

declare global {
  interface WindowEventMap {
    'aifred:history-search-request': CustomEvent<HistorySearchRequestDetail>
  }
}

/** 打开独立的跨会话历史搜索；结果只能来自真实 conversations + entries。 */
export function requestHistorySearch(initialQuery?: string): void {
  window.dispatchEvent(new CustomEvent<HistorySearchRequestDetail>(HISTORY_SEARCH_REQUEST_EVENT, {
    detail: { initialQuery: initialQuery?.trim() || undefined },
  }))
}
