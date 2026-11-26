import { useRef, useState, useEffect, useLayoutEffect, forwardRef, useImperativeHandle, useCallback, useId, useMemo } from 'react'
import './MentionInput.css'
import { PopoverPortal } from '../Popover/PopoverLayer'
import { useAnchoredPopover } from '../Popover/useAnchoredPopover'
import { useGlobalShortcutClose } from '../../hooks/useGlobalShortcut'
import type { GroupMember } from '../../stores/chat'
import { isImeKeyboardEvent } from '../../lib/imeKeyboard'
import { extractMentionText, type RichTextNodeLike } from './mentionRichText'

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
  /** 可 @ 的成员；单聊传空数组，@ 菜单不会出现，其余输入行为与群聊完全一致。 */
  members: GroupMember[]
  placeholder?: string
  disabled?: boolean
  style?: React.CSSProperties
  className?: string
  autoFocus?: boolean
  onEnter: () => void
  onChange: (text: string, mentions: string[]) => void
  /**
   * Images and files pasted or dropped into the box. They are handed over as attachments — the
   * same thing the attachment button produces — instead of being dropped into the text.
   * Without this callback the input falls back to a hint telling the user to use that button.
   */
  onFiles?: (files: File[]) => void
}

/** 粘贴/换行会插入 <div>、<p>、<br> 等结构，展开逻辑见 mentionRichText（递归遍历子树）。 */
function toRichTextNode(node: Node): RichTextNodeLike {
  const element = node instanceof HTMLElement ? node : null
  return {
    nodeType: node.nodeType,
    childNodes: Array.from(node.childNodes, toRichTextNode),
    textContent: node.textContent,
    tagName: element?.tagName,
    dataset: element
      ? { mentionId: element.dataset.mentionId, mentionName: element.dataset.mentionName }
      : undefined,
  }
}

const extract = (el: HTMLDivElement) => extractMentionText(toRichTextNode(el))

/**
 * 内容全删后 contentEditable 常留下占位 <br>，`:empty` 不再命中、占位文字消失；
 * 这里按提取结果标记空态，CSS 用 `[data-empty="true"]` 显示占位。
 */
function markEmpty(el: HTMLDivElement, value: { text: string; mentions: string[] }): void {
  el.dataset.empty = String(value.text === '' && value.mentions.length === 0)
}

/** 把光标放到输入框内容末尾。contentEditable 被程序改写内容或被 focus() 时，Chrome 会把光标留在开头。 */
function caretToEnd(el: HTMLDivElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * Files carried by a paste or a drop. `DataTransfer.files` is empty for a dragged file until the
 * drop itself fires, so `items` is the one that answers "is a file coming" during dragover.
 */
function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return []
  if (data.files && data.files.length > 0) return Array.from(data.files)
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function carriesFiles(data: DataTransfer | null | undefined): boolean {
  if (!data) return false
  if (data.files && data.files.length > 0) return true
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}

const MentionInput = forwardRef<MentionInputHandle, Props>(({
  members, placeholder, disabled, style, className, autoFocus, onEnter, onChange, onFiles,
}, ref) => {
  const editRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  // @ 所在行相对输入框的位置；成员菜单左对齐输入框、贴在这一行上方。
  const [caret, setCaret] = useState({ top: 0, height: 0 })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const isComposingRef = useRef(false)
  const menuId = useId()
  // 宿主没接附件（onFiles 缺失）时的短暂提示；静静丢掉会让用户以为程序卡住。
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const showHint = useCallback((message: string) => {
    setHint(message)
    clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), 2600)
  }, [])
  useEffect(() => () => clearTimeout(hintTimer.current), [])

  const emit = useCallback((el: HTMLDivElement) => {
    const value = extract(el)
    markEmpty(el, value)
    onChange(value.text, value.mentions)
  }, [onChange])

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
    emit(el)
  }, [closeMenu, emit])

  const handleInput = useCallback(() => {
    const el = editRef.current
    if (!el) return
    // 粘贴（尤其跨应用粘贴）后 selection 可能暂时不在输入框内或 rangeCount 为 0，
    // 此时不能提前 return，否则 mentionText 不更新、发送按钮一直禁用。
    const sel = window.getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    const node = range?.startContainer
    if (node && node.nodeType === Node.TEXT_NODE) {
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
    emit(el)
  }, [closeMenu, emit])

  // 只接收纯文本：浏览器默认粘贴会把富文本结构（<div>/<p>/<span>/style）和 <img> 塞进 contenteditable，
  // 既污染输入内容，也让 extract 拿到与用户所见不一致的文本——图片会显示在框里却永远发不出去。
  const insertPlainText = useCallback((el: HTMLDivElement, pasted: string) => {
    closeMenu()
    el.focus()
    const sel = window.getSelection()
    // 焦点不在输入框内时插到末尾，避免文本落到不可见位置。
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) caretToEnd(el)
    const inserted = document.execCommand('insertText', false, pasted)
    if (!inserted) {
      const activeSel = window.getSelection()
      const range = activeSel && activeSel.rangeCount ? activeSel.getRangeAt(0) : null
      if (!activeSel || !range || !el.contains(range.startContainer)) return
      const node = document.createTextNode(pasted)
      range.deleteContents()
      range.insertNode(node)
      const after = document.createRange()
      after.setStartAfter(node)
      after.collapse(true)
      activeSel.removeAllRanges()
      activeSel.addRange(after)
    }
    emit(el)
  }, [closeMenu, emit])

  /** Files go to the attachment list; text keeps being inserted as text. */
  const takeFiles = useCallback((data: DataTransfer | null | undefined, source: 'paste' | 'drop'): boolean => {
    if (!carriesFiles(data)) return false
    const files = filesOf(data)
    if (onFiles && files.length > 0) {
      onFiles(files)
      return true
    }
    showHint(source === 'paste'
      ? '输入框不支持粘贴图片或文件，请用附件按钮上传'
      : '输入框不支持拖入图片或文件，请用附件按钮上传')
    return true
  }, [onFiles, showHint])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = editRef.current
    if (!el || disabled) return
    // 无论剪贴板里是什么都先拦掉浏览器默认粘贴：文本由我们插入，图片/文件走附件。
    e.preventDefault()
    takeFiles(e.clipboardData, 'paste')
    const pasted = e.clipboardData?.getData('text/plain') ?? ''
    if (pasted) insertPlainText(el, pasted)
  }, [disabled, insertPlainText, takeFiles])

  // 拖入同理：默认行为会把图片/文件/富文本直接落进 contenteditable。
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const el = editRef.current
    if (!el || disabled) return
    e.preventDefault()
    if (takeFiles(e.dataTransfer, 'drop')) return
    const dropped = e.dataTransfer?.getData('text/plain') ?? ''
    if (!dropped) return
    insertPlainText(el, dropped)
  }, [disabled, insertPlainText, takeFiles])

  /** Without this the browser refuses the drop and shows a “no entry” cursor over the box. */
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !carriesFiles(e.dataTransfer)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [disabled])

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
        emit(editRef.current!)
      }
    }
  }, [query, filtered, selectedIdx, insertMention, closeMenu, onEnter, emit])

  useImperativeHandle(ref, () => ({
    clear: () => {
      const el = editRef.current
      if (!el) return
      el.replaceChildren()
      emit(el)
    },
    focus: () => {
      const el = editRef.current
      if (!el) return
      el.focus()
      // 程序化聚焦时 Chrome 把光标留在开头，新输入的字会插到已有草稿前面。
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) caretToEnd(el)
    },
    setText: (text: string) => {
      const el = editRef.current
      if (!el) return
      // 草稿恢复只写纯文本，不把持久化内容当 HTML 注入。
      el.textContent = text
      // 改写内容会让光标回到开头（草稿恢复后输入的字会插在草稿前面）；
      // 焦点在别的控件上时不抢选区，等 focus() 再把光标放到末尾。
      if (document.activeElement === el || !document.activeElement || document.activeElement === document.body) {
        caretToEnd(el)
      }
      emit(el)
    },
    snapshot: () => Array.from(editRef.current?.childNodes ?? [], (node) => node.cloneNode(true)),
    restore: (snapshot: MentionInputSnapshot) => {
      const el = editRef.current
      if (!el) return
      // 只放回本输入框自己克隆的节点，不解析任何 HTML。
      el.replaceChildren(...snapshot.map((node) => node.cloneNode(true)))
      emit(el)
      // 发送期间输入框被禁用、焦点落到 body；用户点了别处就不抢焦点。
      if (document.activeElement && document.activeElement !== document.body) return
      el.focus()
      caretToEnd(el)
    },
    insertText: (text: string) => {
      const el = editRef.current
      if (!el || !text) return
      el.focus()
      // 光标不在输入框内时移到末尾，保证插入位置可预期
      const sel = window.getSelection()
      if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) caretToEnd(el)
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
          emit(el)
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
  }), [emit])

  useEffect(() => {
    if (autoFocus) editRef.current?.focus()
  }, [autoFocus])

  return (
    <div className="mention-input-wrapper" ref={wrapperRef}>
      {hint && <div className="mention-input-hint" role="status" aria-live="polite">{hint}</div>}
      <div
        ref={editRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={`mention-input ${className ?? ''}`}
        style={style}
        data-placeholder={placeholder ?? '输入消息…'}
        onInput={handleInput}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={() => { isComposingRef.current = false }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        role="textbox"
        aria-label={placeholder ?? '输入消息'}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-autocomplete={members.length > 0 ? 'list' : undefined}
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
