import { useRef, useState, useEffect, useLayoutEffect, forwardRef, useImperativeHandle, useCallback, useId, useMemo } from 'react'
import './MentionInput.css'
import { PopoverPortal } from '../Popover/PopoverLayer'
import { useAnchoredPopover } from '../Popover/useAnchoredPopover'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import type { GroupMember } from '../../stores/chat'
import { isImeKeyboardEvent } from '../../lib/imeKeyboard'

export interface MentionInputHandle {
  clear: () => void
  focus: () => void
  insertText: (text: string) => void
  setText: (text: string) => void
  /** 发送前保存输入内容（含 @ 成员标签），发送失败时用 restore 原样放回；焦点没被移走时聚焦到末尾。 */
  snapshot: () => MentionInputSnapshot
  restore: (snapshot: MentionInputSnapshot) => void
  getScrollHeight: () => number
}

export type MentionInputSnapshot = readonly Node[]

interface Props {
  members: GroupMember[]
  placeholder?: string
  disabled?: boolean
  style?: React.CSSProperties
  className?: string
  autoFocus?: boolean
  onEnter: () => void
  onChange: (text: string, mentions: string[]) => void
}

function extract(el: HTMLDivElement): { text: string; mentions: string[] } {
  const mentions: string[] = []
  let text = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    } else if (node instanceof HTMLElement && node.dataset.mentionId) {
      text += `@${node.dataset.mentionName ?? ''}`
      mentions.push(node.dataset.mentionId)
    }
  }
  return { text, mentions }
}

const MentionInput = forwardRef<MentionInputHandle, Props>(({
  members, placeholder, disabled, style, className, autoFocus, onEnter, onChange,
}, ref) => {
  const editRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  // @ 所在行相对输入框的位置；成员菜单左对齐输入框、贴在这一行上方。
  const [caret, setCaret] = useState({ top: 0, height: 0 })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const isComposingRef = useRef(false)
  const menuId = useId()

  const filtered = useMemo(() => query !== null
    ? members.filter(m => m.can_mention !== false && m.display_name.toLowerCase().includes(query.toLowerCase()))
    : [], [members, query])
  const menuOpen = query !== null && filtered.length > 0
  const popover = useAnchoredPopover({ open: menuOpen, placement: 'top-start', fallbackPlacements: ['bottom-start'], offset: 4, fit: { maxHeight: 200 } })
  const { setPositionReference } = popover.refs
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    if (!menuOpen || !wrapper) return
    // 虚拟锚点：输入框左边缘 + @ 所在行，按输入框的实时位置算，输入栏移动时菜单跟着走。
    setPositionReference({
      contextElement: wrapper,
      getBoundingClientRect: () => {
        const box = wrapper.getBoundingClientRect()
        const top = box.top + caret.top
        return { x: box.left, y: top, left: box.left, top, right: box.left, bottom: top + caret.height, width: 0, height: caret.height }
      },
    })
  }, [menuOpen, caret, setPositionReference])

  const closeMenu = useCallback(() => {
    setQuery(null)
    setSelectedIdx(0)
  }, [])

  useGlobalShortcutClose({ active: query !== null && filtered.length > 0, onClose: closeMenu })

  const insertMention = useCallback((member: GroupMember) => {
    const el = editRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return

    const text = node.textContent ?? ''
    const offset = range.startOffset
    const atIdx = text.lastIndexOf('@', offset - 1)
    if (atIdx < 0) return

    const delRange = document.createRange()
    delRange.setStart(node, atIdx)
    delRange.setEnd(node, offset)
    delRange.deleteContents()

    const chip = document.createElement('span')
    chip.contentEditable = 'false'
    // Agent prompt 契约使用员工 handle 解析群聊 @；旧数据缺 handle 时才回退 employee_id。
    chip.dataset.mentionId = member.handle ?? member.employee_id
    chip.dataset.mentionName = member.display_name
    chip.className = 'mention-chip'
    chip.textContent = `@${member.display_name}`

    const space = document.createTextNode(' ')
    delRange.insertNode(space)
    delRange.insertNode(chip)

    const newRange = document.createRange()
    newRange.setStartAfter(space)
    newRange.collapse(true)
    sel.removeAllRanges()
    sel.addRange(newRange)

    closeMenu()
    const { text: t, mentions } = extract(el)
    onChange(t, mentions)
  }, [closeMenu, onChange])

  const handleInput = useCallback(() => {
    const el = editRef.current
    if (!el) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType === Node.TEXT_NODE) {
      const before = (node.textContent ?? '').slice(0, range.startOffset)
      const atIdx = before.lastIndexOf('@')
      if (atIdx >= 0 && (atIdx === 0 || /\s/.test(before[atIdx - 1]))) {
        setQuery(before.slice(atIdx + 1))
        setSelectedIdx(0)
        const rect = range.getBoundingClientRect()
        const boxRect = wrapperRef.current?.getBoundingClientRect()
        setCaret(boxRect ? { top: rect.top - boxRect.top, height: rect.height } : { top: 0, height: 0 })
      } else {
        closeMenu()
      }
    } else {
      closeMenu()
    }
    const { text, mentions } = extract(el)
    onChange(text, mentions)
  }, [closeMenu, onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // 组词期间让输入法处理回车、方向键和删除键，不选择 @ 成员或发送。
    if (isImeKeyboardEvent(e.nativeEvent, isComposingRef.current)) return
    if (query !== null && filtered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filtered[selectedIdx]); return }
      if (e.key === 'Escape') { closeMenu(); return }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onEnter()
      return
    }

    if (e.key === 'Backspace') {
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !sel.getRangeAt(0).collapsed) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      const offset = range.startOffset
      let chipToDelete: Element | null = null

      if (node.nodeType === Node.TEXT_NODE && offset === 0 && node.previousSibling instanceof HTMLElement && node.previousSibling.dataset.mentionId) {
        chipToDelete = node.previousSibling
      } else if (node === editRef.current && offset > 0) {
        const prev = editRef.current.childNodes[offset - 1]
        if (prev instanceof HTMLElement && prev.dataset.mentionId) chipToDelete = prev
      }

      if (chipToDelete) {
        e.preventDefault()
        chipToDelete.remove()
        const { text, mentions } = extract(editRef.current!)
        onChange(text, mentions)
      }
    }
  }, [query, filtered, selectedIdx, insertMention, closeMenu, onEnter, onChange])

  useImperativeHandle(ref, () => ({
    clear: () => { if (editRef.current) { editRef.current.innerHTML = ''; onChange('', []) } },
    focus: () => editRef.current?.focus(),
    setText: (text: string) => {
      if (!editRef.current) return
      // 草稿恢复只写纯文本，不把持久化内容当 HTML 注入。
      editRef.current.textContent = text
    },
    snapshot: () => Array.from(editRef.current?.childNodes ?? [], (node) => node.cloneNode(true)),
    restore: (snapshot: MentionInputSnapshot) => {
      const el = editRef.current
      if (!el) return
      // 只放回本输入框自己克隆的节点，不解析任何 HTML。
      el.replaceChildren(...snapshot.map((node) => node.cloneNode(true)))
      const { text, mentions } = extract(el)
      onChange(text, mentions)
      // 发送期间输入框被禁用、焦点落到 body；用户点了别处就不抢焦点。
      if (document.activeElement && document.activeElement !== document.body) return
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    },
    insertText: (text: string) => {
      const el = editRef.current
      if (!el || !text) return
      el.focus()
      // 光标不在输入框内时移到末尾，保证插入位置可预期
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      // 前面已有内容且非空白时补一个空格分隔
      const needsSpace = el.textContent !== '' && !/\s$/.test(el.textContent ?? '')
      const inserted = document.execCommand('insertText', false, (needsSpace ? ' ' : '') + text)
      if (!inserted) {
        // execCommand 不可用时的兜底：手动插文本节点并触发 onChange
        const activeSel = window.getSelection()
        const range = activeSel && activeSel.rangeCount ? activeSel.getRangeAt(0) : null
        if (activeSel && range && el.contains(range.startContainer)) {
          const node = document.createTextNode((needsSpace ? ' ' : '') + text)
          range.insertNode(node)
          const after = document.createRange()
          after.setStartAfter(node)
          after.collapse(true)
          activeSel.removeAllRanges()
          activeSel.addRange(after)
          const { text: t, mentions } = extract(el)
          onChange(t, mentions)
        }
      }
    },
    getScrollHeight: () => {
      const el = editRef.current
      if (!el) return 60
      const prev = el.style.height
      el.style.height = 'auto'
      const h = el.scrollHeight
      el.style.height = prev
      return h
    },
  }), [onChange])

  useEffect(() => {
    if (autoFocus) editRef.current?.focus()
  }, [autoFocus])

  return (
    <div className="mention-input-wrapper" ref={wrapperRef}>
      <div
        ref={editRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={`mention-input ${className ?? ''}`}
        style={style}
        data-placeholder={placeholder ?? '输入消息…'}
        onInput={handleInput}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={() => { isComposingRef.current = false }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        role="textbox"
        aria-label={placeholder ?? '输入消息'}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-autocomplete="list"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-activedescendant={menuOpen ? `${menuId}-option-${selectedIdx}` : undefined}
      />
      {menuOpen && <PopoverPortal>
        <div ref={popover.refs.setFloating} className="mention-dropdown" id={menuId} role="listbox" aria-label="可提及的群成员" style={popover.floatingStyles}>
          {filtered.map((m, i) => (
            <button
              key={m.employee_id}
              id={`${menuId}-option-${i}`}
              type="button"
              role="option"
              aria-selected={i === selectedIdx}
              className={`mention-option${i === selectedIdx ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); insertMention(m) }}
              onClick={() => insertMention(m)}
            >
              {m.display_name}
            </button>
          ))}
        </div>
      </PopoverPortal>}
    </div>
  )
})

MentionInput.displayName = 'MentionInput'
export default MentionInput
