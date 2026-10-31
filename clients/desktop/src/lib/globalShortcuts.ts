export type GlobalShortcut = 'new' | 'close'
export type GlobalShortcutActionKind = GlobalShortcut
export type ContextualNewAction = 'chat' | 'group'

export const GLOBAL_SHORTCUT_PRIORITY = {
  contextualNew: 100,
  panel: 200,
  overlay: 300,
} as const

export interface GlobalShortcutKeyboardEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented: boolean
  repeat: boolean
  isComposing?: boolean
  keyCode?: number
  target?: EventTarget | null
  preventDefault: () => void
  stopPropagation?: () => void
}

export interface GlobalShortcutAction {
  kind: GlobalShortcutActionKind
  priority: number
  handler: () => void | Promise<void>
}

interface RegisteredShortcutAction extends GlobalShortcutAction {
  token: symbol
  order: number
}

export interface GlobalShortcutRuntime {
  registry: GlobalShortcutRegistry
  isTauri: boolean
  closeTauriWindow: () => void | Promise<void>
  onActionError?: (error: unknown) => void
  onWindowCloseError?: (error: unknown) => void
}

interface EditableTarget {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
}

export interface ContextualNewCapabilities {
  canCreateChat: boolean
  canCreateGroup: boolean
}

/** 未列出的路由不会获得 ⌘N，避免把预览页或不可用写接口伪装成新建能力。 */
export function resolveContextualNewAction(
  pathname: string,
  capabilities: ContextualNewCapabilities,
): ContextualNewAction | null {
  if (pathname === '/chat' || pathname.startsWith('/chat/')) {
    return capabilities.canCreateChat ? 'chat' : null
  }
  if (pathname === '/group-chat' || pathname.startsWith('/group-chat/')) {
    return capabilities.canCreateGroup ? 'group' : null
  }
  return null
}

/**
 * 依据优先级和最近打开顺序选择动作。注册返回的清理函数可重复调用，
 * 以保证 React StrictMode 的 mount → cleanup → mount 不残留旧 handler。
 */
export class GlobalShortcutRegistry {
  private readonly actions = new Map<symbol, RegisteredShortcutAction>()
  private nextOrder = 0

  register(action: GlobalShortcutAction): () => void {
    const token = Symbol(action.kind)
    this.nextOrder += 1
    this.actions.set(token, { ...action, token, order: this.nextOrder })
    let active = true

    return () => {
      if (!active) return
      active = false
      this.actions.delete(token)
    }
  }

  top(kind: GlobalShortcutActionKind): GlobalShortcutAction | null {
    let winner: RegisteredShortcutAction | null = null
    for (const action of this.actions.values()) {
      if (action.kind !== kind) continue
      if (!winner
        || action.priority > winner.priority
        || (action.priority === winner.priority && action.order > winner.order)) {
        winner = action
      }
    }
    return winner
  }

  hasCloseOverlay(): boolean {
    const topClose = this.top('close')
    return Boolean(topClose && topClose.priority >= GLOBAL_SHORTCUT_PRIORITY.overlay)
  }

  get size(): number {
    return this.actions.size
  }
}

export function isEditableShortcutTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false
  const candidate = target as EditableTarget
  const tagName = candidate.tagName?.toLocaleLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  if (candidate.isContentEditable) return true
  return candidate.getAttribute?.('contenteditable') === 'true'
}

/** 精确匹配 ⌘/Ctrl + N/W；组合键、按键重复与 IME 合成态均交还原处理方。 */
export function resolveGlobalShortcut(event: GlobalShortcutKeyboardEvent): GlobalShortcut | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return null
  if (event.altKey || event.shiftKey || event.metaKey === event.ctrlKey) return null

  const key = event.key.toLocaleLowerCase()
  if (key === 'n') return 'new'
  if (key === 'w') return 'close'
  return null
}

function runAction(
  action: GlobalShortcutAction,
  onError: ((error: unknown) => void) | undefined,
): void {
  try {
    void Promise.resolve(action.handler()).catch((error: unknown) => onError?.(error))
  } catch (error) {
    onError?.(error)
  }
}

function consumeShortcut(event: GlobalShortcutKeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation?.()
}

/**
 * 执行一次快捷键仲裁。返回 true 表示应用已消费事件。
 *
 * - ⌘N/Ctrl+N：输入区域、顶层弹层或无真实新建动作时不消费。
 * - ⌘W/Ctrl+W：先关闭注册层；Tauri 中最后关闭窗口；浏览器中只阻止误关 tab。
 */
export function handleGlobalShortcut(
  event: GlobalShortcutKeyboardEvent,
  runtime: GlobalShortcutRuntime,
): boolean {
  const shortcut = resolveGlobalShortcut(event)
  if (!shortcut) return false

  if (shortcut === 'new') {
    if (isEditableShortcutTarget(event.target) || runtime.registry.hasCloseOverlay()) return false
    const action = runtime.registry.top('new')
    if (!action) return false
    consumeShortcut(event)
    runAction(action, runtime.onActionError)
    return true
  }

  const closeAction = runtime.registry.top('close')
  if (closeAction) {
    consumeShortcut(event)
    runAction(closeAction, runtime.onActionError)
    return true
  }

  // 浏览器开发环境必须拦截原生“关闭标签页”；只有确认处于 Tauri runtime 才调用窗口 API。
  consumeShortcut(event)
  if (runtime.isTauri) {
    runAction(
      { kind: 'close', priority: 0, handler: runtime.closeTauriWindow },
      runtime.onWindowCloseError,
    )
  }
  return true
}
