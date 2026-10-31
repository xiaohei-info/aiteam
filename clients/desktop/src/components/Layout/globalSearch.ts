export type GlobalSearchRequestSource = 'button' | 'keyboard'

export interface GlobalSearchRequestDetail {
  source: GlobalSearchRequestSource
}

export interface GlobalSearchShortcutEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented: boolean
  repeat: boolean
  isComposing?: boolean
}

export const GLOBAL_SEARCH_REQUEST_EVENT = 'aifred:global-search-request'

declare global {
  interface WindowEventMap {
    'aifred:global-search-request': CustomEvent<GlobalSearchRequestDetail>
  }
}

/** 只接受不处于输入法合成态的精确 Command/Ctrl+K，普通输入不会触发全局搜索。 */
export function isGlobalSearchShortcut(event: GlobalSearchShortcutEvent): boolean {
  return !event.defaultPrevented
    && !event.repeat
    && !event.isComposing
    && !event.altKey
    && !event.shiftKey
    && (event.metaKey || event.ctrlKey)
    && event.key.toLocaleLowerCase() === 'k'
}

/** A1.3 的 Command Palette 监听此事件；A1.2 只定义入口，不生成任何搜索结果。 */
export function requestGlobalSearch(source: GlobalSearchRequestSource) {
  window.dispatchEvent(new CustomEvent<GlobalSearchRequestDetail>(GLOBAL_SEARCH_REQUEST_EVENT, {
    detail: { source },
  }))
}
