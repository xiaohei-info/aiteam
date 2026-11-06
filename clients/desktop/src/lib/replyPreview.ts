/** Opening of a long reply shown in the chat while the full text lives in a saved Markdown file. */

export const REPLY_PREVIEW_CHARS = 500

const FENCE = /^\s*(```|~~~)/

/**
 * About the first `max` characters of `text`, cut at a line break when one falls in the last 40%
 * so a sentence or table row is not split. A code block left open is closed, so the rest of the
 * chat does not render as code. Counts Unicode characters, not UTF-16 units.
 */
export function replyPreview(text: string, max = REPLY_PREVIEW_CHARS): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let head = chars.slice(0, max).join('')
  const lineBreak = head.lastIndexOf('\n')
  if (lineBreak >= 0 && Array.from(head.slice(0, lineBreak)).length >= max * 0.6) head = head.slice(0, lineBreak)
  head = head.trimEnd()
  let fence: string | null = null
  for (const line of head.split('\n')) {
    const match = FENCE.exec(line)
    if (!match) continue
    if (fence === null) fence = match[1]
    else if (match[1] === fence) fence = null
  }
  return fence === null ? `${head}\n\n…` : `${head}\n${fence}\n\n…`
}
