/** Opening of a long reply shown in the chat while the full text lives in a saved Markdown file. */

export const REPLY_PREVIEW_CHARS = 500

const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function openFence(head: string): string | null {
  let fence: string | null = null
  for (const line of head.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) continue
    if (fence === null) fence = match[1]
    else if (match[1] === fence) fence = null
  }
  return fence
}

/**
 * `head` without a table it cuts off: a header and a few rows read as a broken table, so the preview
 * stops before the table. A reply that opens with a table keeps whole rows, at least the first one.
 */
function withoutCutTable(head: string, text: string): string {
  const lines = text.split('\n')
  const kept = head.split('\n')
  const last = kept.length - 1
  if (!TABLE_ROW.test(lines[last])) return head
  const wholeLine = kept[last].trimEnd() === lines[last].trimEnd()
  if (wholeLine && !TABLE_ROW.test(lines[last + 1] ?? '')) return head
  let start = last
  while (start > 0 && TABLE_ROW.test(lines[start - 1])) start -= 1
  if (!TABLE_RULE.test(lines[start + 1] ?? '')) return head
  const before = lines.slice(0, start).join('\n').trimEnd()
  if (before) return before
  return lines.slice(0, Math.max(start + 3, wholeLine ? last + 1 : last)).join('\n').trimEnd()
}

/**
 * About the first `max` characters of `text`, cut at a line break when one falls in the last 40%
 * so a sentence is not split, and before a table the cut would break. A code block left open is
 * closed, so the rest of the chat does not render as code. Counts Unicode characters, not UTF-16 units.
 */
export function replyPreview(text: string, max = REPLY_PREVIEW_CHARS): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let head = chars.slice(0, max).join('')
  const lineBreak = head.lastIndexOf('\n')
  if (lineBreak >= 0 && Array.from(head.slice(0, lineBreak)).length >= max * 0.6) head = head.slice(0, lineBreak)
  head = head.trimEnd()
  if (openFence(head) === null) head = withoutCutTable(head, text)
  const fence = openFence(head)
  return fence === null ? `${head}\n\n…` : `${head}\n${fence}\n\n…`
}
