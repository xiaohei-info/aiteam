/**
 * 锚定浮层的渲染层：PopoverPortal 把浮层渲染到 body；PopoverTabOrder 让渲染到 body 的非模态浮层
 * 在 Tab 顺序上仍紧跟锚点（锚点 → 浮层内按钮 → 锚点后面的控件），不抢焦点、不在失焦时关闭。
 * 模态面板（自己用 useDialogFocus 管焦点的）只需要 PopoverPortal。
 */
import { FloatingFocusManager, FloatingPortal, type FloatingContext, type ReferenceType } from '@floating-ui/react'
import type { ReactElement, ReactNode } from 'react'

export function PopoverPortal({ children }: { children: ReactNode }) {
  return <FloatingPortal>{children}</FloatingPortal>
}

export function PopoverTabOrder<R extends ReferenceType>({ context, children }: {
  context: FloatingContext<R>
  children: ReactElement
}) {
  return (
    <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false} closeOnFocusOut={false}>
      {children}
    </FloatingFocusManager>
  )
}
