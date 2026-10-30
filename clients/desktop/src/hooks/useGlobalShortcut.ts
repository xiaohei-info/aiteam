import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  GLOBAL_SHORTCUT_PRIORITY,
  GlobalShortcutRegistry,
  type GlobalShortcutActionKind,
} from '../lib/globalShortcuts'

export const globalShortcutRegistry = new GlobalShortcutRegistry()

interface UseGlobalShortcutActionOptions {
  active?: boolean
  kind: GlobalShortcutActionKind
  priority: number
  handler: () => void | Promise<void>
}

interface UseGlobalShortcutCloseOptions {
  active?: boolean
  layer?: 'overlay' | 'panel'
  onClose: () => void | Promise<void>
}

/** 注册状态变化会重新排到同级栈顶；回调变化只更新 ref，不扰动打开顺序。 */
export function useGlobalShortcutAction({
  active = true,
  kind,
  priority,
  handler,
}: UseGlobalShortcutActionOptions): void {
  const handlerRef = useRef(handler)

  useLayoutEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    if (!active) return undefined
    return globalShortcutRegistry.register({
      kind,
      priority,
      handler: () => handlerRef.current(),
    })
  }, [active, kind, priority])
}

export function useGlobalShortcutClose({
  active = true,
  layer = 'overlay',
  onClose,
}: UseGlobalShortcutCloseOptions): void {
  useGlobalShortcutAction({
    active,
    kind: 'close',
    priority: GLOBAL_SHORTCUT_PRIORITY[layer],
    handler: onClose,
  })
}

export function useGlobalShortcutNew(
  handler: () => void | Promise<void>,
  active = true,
): void {
  useGlobalShortcutAction({
    active,
    kind: 'new',
    priority: GLOBAL_SHORTCUT_PRIORITY.contextualNew,
    handler,
  })
}
