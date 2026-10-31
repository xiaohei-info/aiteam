import { useRef, useState, useEffect, useLayoutEffect } from 'react'

/** 距底部小于该值视为“在底部”，新内容渲染时自动贴底。 */
const STICK_TO_BOTTOM_THRESHOLD = 120

interface UseChatScrollOptions {
  messagesLength: number
  activeId: string
  hasMore: boolean | undefined
  loadMore: (id: string, isGroup?: boolean) => Promise<boolean | undefined>
  isGroup?: boolean
}

export function useChatScroll({
  messagesLength,
  activeId,
  hasMore,
  loadMore,
  isGroup = false,
}: UseChatScrollOptions) {
  const msgListRef = useRef<HTMLDivElement>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const lastScrollTopRef = useRef(0)

  useLayoutEffect(() => {
    const el = msgListRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }, [messagesLength])

  // 两种情况会让底部内容被输入栏遮住，而 scrollTop 不会自己变化：
  // 1. 员工回复流式渲染，消息条数不变但气泡变高；
  // 2. 输入栏变高（待发送队列、附件预览、多行输入），消息列表可视区变矮。
  // 用户停留在底部附近时贴底跟随；用户主动往上翻看历史时，只补偿可视区变矮的距离，不打断阅读。
  useEffect(() => {
    const el = msgListRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const distanceFromBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight
    let stickToBottom = true
    let prevHeight = el.clientHeight
    const handleScroll = () => { stickToBottom = distanceFromBottom() < STICK_TO_BOTTOM_THRESHOLD }
    const observer = new ResizeObserver(() => {
      const height = el.clientHeight
      const shrink = prevHeight - height
      prevHeight = height
      if (stickToBottom) el.scrollTop = el.scrollHeight
      else if (shrink > 0) el.scrollTop += shrink
      else return
      lastScrollTopRef.current = el.scrollTop
    })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', handleScroll)
    }
  }, [activeId])

  useEffect(() => {
    const el = msgListRef.current
    if (!el) return

    const triggerLoadMore = async () => {
      if (isLoadingMore || hasMore === false) return
      setIsLoadingMore(true)
      const prevHeight = el.scrollHeight
      const added = await loadMore(activeId, isGroup || undefined)
      if (added) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight
          lastScrollTopRef.current = el.scrollTop
        })
      }
      setIsLoadingMore(false)
    }

    const handleScroll = () => {
      const scrollTop = el.scrollTop
      const scrollingUp = scrollTop < lastScrollTopRef.current
      lastScrollTopRef.current = scrollTop
      if (!scrollingUp || scrollTop > 60) return
      void triggerLoadMore()
    }

    // 消息量不足以出现滚动条时，scroll 事件不会触发。监听 wheel 兜底：
    // 向上滚（deltaY < 0）且已经在顶部（scrollTop 接近 0）就直接拉更早的历史。
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY >= 0) return
      if (el.scrollTop > 60) return
      void triggerLoadMore()
    }

    el.addEventListener('scroll', handleScroll)
    el.addEventListener('wheel', handleWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      el.removeEventListener('wheel', handleWheel)
    }
  }, [activeId, isLoadingMore, hasMore, loadMore, isGroup])

  const scrollToBottom = () => {
    const el = msgListRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
  }

  return { msgListRef, isLoadingMore, scrollToBottom }
}
