import type { MessageAttachment } from '../stores/chat'

/**
 * Agent 把按路径引用的附件写成一段清单追加在用户消息末尾（server/agent_service
 * src/pi/attachment-refs.ts 的 attachmentManifest），给模型看编号和文件名。
 * 展示时去掉这段，改成附件卡片。
 */
const HEADER = '\n\n[用户附件，可用 attachment_read 工具按编号读取]\n'
const LINE = /^- (ref-[^：\s]+)：(.+)（(PDF|Word 文档|图片|视频|音频|文本|文件)，[^，）]+(?:，[^）]*)?）$/u

const KIND_MIME: Record<string, string> = {
  PDF: 'application/pdf',
  'Word 文档': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  图片: 'image/*',
  视频: 'video/*',
  音频: 'audio/*',
  文本: 'text/plain',
  文件: 'application/octet-stream',
}

export function splitAttachmentManifest(text: string): { text: string; attachments: MessageAttachment[] } {
  const start = text.lastIndexOf(HEADER)
  if (start < 0) return { text, attachments: [] }
  const lines = text.slice(start + HEADER.length).trimEnd().split('\n')
  const attachments: MessageAttachment[] = []
  for (const line of lines) {
    const match = LINE.exec(line)
    if (!match) return { text, attachments: [] }
    const [, id, name, kind] = match
    attachments.push({ id, filename: name, name, mime_type: KIND_MIME[kind], kind: kind === '图片' ? 'image' : 'file' })
  }
  return { text: text.slice(0, start), attachments }
}

// 历史消息里的附件只有编号和文件名；本机位置由发送时记下，点开时按「会话 + 文件名」找回。
const STORAGE_KEY = 'aiteam.attachment-paths.v1'
const MAX_ENTRIES = 500

type PathEntry = [key: string, path: string]

function readEntries(storage: Storage): PathEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is PathEntry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
      : []
  } catch {
    return []
  }
}

const keyFor = (conversationId: string, name: string) => `${conversationId}\u0000${name}`

export function rememberAttachmentPaths(conversationId: string, attachments: readonly MessageAttachment[] | undefined, storage: Storage = localStorage): void {
  const withPath = (attachments ?? []).filter((att) => att.path)
  if (withPath.length === 0) return
  try {
    const keys = new Set(withPath.map((att) => keyFor(conversationId, att.name ?? att.filename)))
    const kept = readEntries(storage).filter(([key]) => !keys.has(key))
    const added = withPath.map((att): PathEntry => [keyFor(conversationId, att.name ?? att.filename), att.path!])
    storage.setItem(STORAGE_KEY, JSON.stringify([...kept, ...added].slice(-MAX_ENTRIES)))
  } catch {
    // 存储不可用时只影响历史消息里点开附件，不影响发送。
  }
}

export function rememberedAttachmentPath(conversationId: string, name: string, storage: Storage = localStorage): string | undefined {
  try {
    const key = keyFor(conversationId, name)
    return readEntries(storage).reverse().find(([entryKey]) => entryKey === key)?.[1]
  } catch {
    return undefined
  }
}
