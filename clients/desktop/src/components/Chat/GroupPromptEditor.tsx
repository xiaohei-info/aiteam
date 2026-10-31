import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import './CreateGroupDialog.css'
import type { EmployeeMention } from '../../lib/customGroupForm'

interface GroupPromptEditorProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  /** Group members that can be referenced with @. */
  bindings: readonly EmployeeMention[]
  disabled?: boolean
  rows?: number
  autoFocus?: boolean
}

/** Collaboration-rule textarea with an @ picker; the text uses `@【name】` and is encoded to `@{id}` on save. */
export default function GroupPromptEditor({ id, label, value, onChange, bindings, disabled, rows = 8, autoFocus }: GroupPromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionQuery, setMentionQuery] = useState('')

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value
    onChange(text)
    const caret = event.target.selectionStart
    const match = text.slice(0, caret).match(/@([^@\n【{}]*)$/u)
    setMentionStart(match ? caret - match[0].length : null)
    setMentionQuery(match?.[1] ?? '')
  }

  const handleInsert = (binding: EmployeeMention) => {
    const textarea = textareaRef.current
    const start = mentionStart ?? textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? value.length
    const token = `@【${binding.label}】`
    onChange(value.slice(0, start) + token + value.slice(end))
    setMentionStart(null)
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(start + token.length, start + token.length) })
  }

  // Escape closes the picker first, so it does not also dismiss the surrounding dialog.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Escape' || mentionStart === null || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    setMentionStart(null)
  }

  const options = bindings.filter(binding => binding.label.includes(mentionQuery))
  return (
    <>
      <textarea
        ref={textareaRef}
        id={id}
        aria-label={label}
        className="cgd-textarea cgd-prompt"
        rows={rows}
        maxLength={16000}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder="填写协作目标、编号步骤和交付要求；输入 @ 选择群内员工。"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {mentionStart !== null && (
        <div className="cgd-mention-picker" aria-label="插入群成员引用">
          {options.map(binding => (
            <button type="button" className="cgd-member-btn" key={binding.id}
              onMouseDown={event => event.preventDefault()} onClick={() => handleInsert(binding)}>{binding.label}</button>
          ))}
          {!options.length && <span>没有匹配的群成员。</span>}
        </div>
      )}
    </>
  )
}
