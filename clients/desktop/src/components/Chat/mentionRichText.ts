/**
 * contentEditable 富文本 → 纯文本 + @ 成员 id 的展开逻辑。
 *
 * 浏览器粘贴多行/富文本时会插入 <div>、<p>、<span>、<br> 等结构；只遍历顶层 childNodes
 * 会把这些结构整体忽略，展开出空字符串，进而让发送按钮判定为「无内容」而一直禁用。
 * 因此这里递归遍历子树，并只依赖节点结构（childNodes / nodeType / tagName / textContent / dataset），
 * 不依赖真实 DOM 类型，便于在 node:test 下用假节点覆盖各分支。
 */

export interface RichTextNodeLike {
  nodeType: number
  childNodes: ReadonlyArray<RichTextNodeLike>
  textContent?: string | null
  tagName?: string
  dataset?: { mentionId?: string; mentionName?: string }
}

export const TEXT_NODE = 3
export const ELEMENT_NODE = 1

/** 块级容器：相邻块之间补换行，避免多行内容被拼成一行。 */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'SECTION', 'ARTICLE'])

export interface ExtractedMentionText {
  text: string
  mentions: string[]
}

export function extractMentionText(root: RichTextNodeLike): ExtractedMentionText {
  const mentions: string[] = []
  let text = ''

  // 块的边界只在「当前行还没结束」时补一个换行；<br> 本身就是一个换行，必须原样保留，
  // 否则 `a<br><br>b` 的空行会被吞掉。块末尾的 <br> 只是占位（如 `<div>a<br></div>`），
  // 它产生的换行同时充当块结束，不会再多出一行。
  const appendBreak = (): void => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
  }

  const walk = (parent: RichTextNodeLike): void => {
    for (const node of parent.childNodes) {
      if (node.nodeType === TEXT_NODE) {
        text += node.textContent ?? ''
        continue
      }
      if (node.nodeType !== ELEMENT_NODE) continue
      const tagName = (node.tagName ?? '').toUpperCase()
      const mentionId = node.dataset?.mentionId
      if (mentionId) {
        text += `@${node.dataset?.mentionName ?? ''}`
        mentions.push(mentionId)
        continue
      }
      if (tagName === 'BR') {
        text += '\n'
        continue
      }
      const isBlock = BLOCK_TAGS.has(tagName)
      if (isBlock) appendBreak()
      walk(node)
      if (isBlock) appendBreak()
    }
  }

  walk(root)
  // 末尾的换行来自块结束或 contentEditable 的占位 <br>，不是用户内容。
  return { text: text.replace(/\n+$/u, ''), mentions }
}
