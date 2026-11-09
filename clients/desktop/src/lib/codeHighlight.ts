/**
 * Prism 高亮的耗时与代码长度近似线性（实测约 60ms/KB，WebKit 更慢），且在渲染阶段同步执行。
 * 超过上限的代码块（常见于整页 HTML）退化为纯文本，避免切换会话时长时间占满主线程。
 */
export const MAX_HIGHLIGHT_CHARS = 4000
export const MAX_HIGHLIGHT_LINES = 100

export function shouldHighlightCode(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false
  let lines = 1
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10 && (lines += 1) > MAX_HIGHLIGHT_LINES) return false
  }
  return true
}
