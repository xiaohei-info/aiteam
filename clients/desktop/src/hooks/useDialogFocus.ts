import { useLayoutEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute('aria-hidden') !== 'true'
      && element.getAttribute('aria-disabled') !== 'true')
}

interface UseDialogFocusOptions {
  active?: boolean
  initialFocusRef?: RefObject<HTMLElement>
}

/** 为弹层提供初始聚焦、Tab 循环与卸载后的焦点回收。 */
export function useDialogFocus<T extends HTMLElement>({
  active = true,
  initialFocusRef,
}: UseDialogFocusOptions = {}): RefObject<T> {
  const dialogRef = useRef<T>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!active || !dialogRef.current) return undefined

    const dialog = dialogRef.current
    const activeElement = document.activeElement
    returnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null

    const frame = window.requestAnimationFrame(() => {
      const initialTarget = initialFocusRef?.current
        ?? dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
        ?? getFocusableElements(dialog)[0]
        ?? dialog
      initialTarget.focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = getFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
      event.preventDefault()
      focusable[nextIndex].focus()
    }

    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      dialog.removeEventListener('keydown', handleKeyDown)
      const returnTarget = returnFocusRef.current
      window.setTimeout(() => {
        if (returnTarget?.isConnected && !returnTarget.hasAttribute('disabled')) returnTarget.focus()
      }, 0)
    }
  }, [active, initialFocusRef])

  return dialogRef
}
