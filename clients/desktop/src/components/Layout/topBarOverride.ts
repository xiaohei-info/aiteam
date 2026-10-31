import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { TopBarBreadcrumb } from './topBarRoutes'

/** 页面内的二级/三级视图可临时接管顶栏（类似 iOS 的 navigation stack）：标题、面包屑与返回动作。 */
export interface TopBarOverride {
  title: string
  breadcrumbs: TopBarBreadcrumb[]
  backLabel: string
  onBack: () => void
}

let current: TopBarOverride | null = null
const listeners = new Set<() => void>()

function setTopBarOverride(next: TopBarOverride | null) {
  current = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTopBarOverrideValue() {
  return useSyncExternalStore(subscribe, () => current)
}

/** 传入 null 表示不接管，使用路由默认顶栏。onBack/onSelect 变化不会触发重新注册。 */
export function useTopBarOverride(override: TopBarOverride | null) {
  const latest = useRef(override)
  latest.current = override
  const key = override
    ? JSON.stringify([override.title, override.backLabel, override.breadcrumbs.map((item) => [item.label, item.to, Boolean(item.onSelect)])])
    : ''

  useEffect(() => {
    const value = latest.current
    if (!value) {
      setTopBarOverride(null)
      return
    }
    setTopBarOverride({
      ...value,
      onBack: () => latest.current?.onBack(),
      breadcrumbs: value.breadcrumbs.map((item, index) => (
        item.onSelect ? { ...item, onSelect: () => latest.current?.breadcrumbs[index]?.onSelect?.() } : item
      )),
    })
    return () => setTopBarOverride(null)
  }, [key])
}
