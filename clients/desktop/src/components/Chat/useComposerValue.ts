import { useCallback, useRef, useState } from 'react'
import type { MentionInputHandle, MentionInputSnapshot } from './MentionInput'

export interface ComposerValue {
  text: string
  mentions: string[]
}

/**
 * 聊天输入框的唯一取值来源：单聊和群聊都渲染 MentionInput（单聊不传成员），
 * 文本、@ 成员、草稿恢复、清空、失败放回都只经过这里，避免两套实现各修一边。
 *
 * - `valueRef` 给事件回调同步读取（发送、切会话时不能等下一次渲染）；
 * - `text` 是渲染用的状态（发送键使能、高度自适应）。
 */
export function useComposerValue(initialText: string) {
  const inputRef = useRef<MentionInputHandle>(null)
  const valueRef = useRef<ComposerValue>({ text: initialText, mentions: [] })
  const [text, setTextState] = useState(initialText)

  /** MentionInput 的 onChange：用户输入、粘贴、插入 chip、restore 都会回调到这里。 */
  const handleChange = useCallback((nextText: string, mentions: string[]) => {
    valueRef.current = { text: nextText, mentions }
    setTextState(nextText)
  }, [])

  /** 写入纯文本（草稿恢复、排队消息没有快照时）；不解析 HTML。 */
  const setText = useCallback((nextText: string) => {
    handleChange(nextText, [])
    inputRef.current?.setText(nextText)
  }, [handleChange])

  const clear = useCallback(() => {
    handleChange('', [])
    inputRef.current?.clear()
  }, [handleChange])

  const snapshot = useCallback((): MentionInputSnapshot | undefined => inputRef.current?.snapshot(), [])

  /** 原样放回发送前的内容（含 @ 成员 chip）；没有快照时退回纯文本。 */
  const restore = useCallback((saved: MentionInputSnapshot | undefined, fallbackText: string) => {
    if (saved && inputRef.current) inputRef.current.restore(saved)
    else setText(fallbackText)
  }, [setText])

  const focus = useCallback(() => inputRef.current?.focus(), [])
  const insertText = useCallback((value: string) => inputRef.current?.insertText(value), [])
  const getScrollHeight = useCallback(() => inputRef.current?.getScrollHeight(), [])

  return { inputRef, valueRef, text, handleChange, setText, clear, snapshot, restore, focus, insertText, getScrollHeight }
}
