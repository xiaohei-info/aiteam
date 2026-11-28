import type { MessageAttachment } from '../stores/chat'

/**
 * Agent 把按路径引用的附件写成一段清单追加在用户消息末尾（server/agent_service
 * src/pi/attachment-refs.ts 的 attachmentManifest），给模型看编号和文件名。
 * 展示时去掉这段，改成附件卡片。
 */
const HEADER = '\n\n[用户附件，可用 attachment_read 工具按编号读取]\n'
// 已上传的附件（attachment_ids）：Agent 把提取的文字放在用户正文和清单之间，展示时一并去掉。
const UPLOADED_TEXT_HEADER = '\n\n[本地附件材料，仅来自当前会话已绑定文件]\n'
const LINE = /^- ([^：\s]+)：(.+)（(PDF|Word 文档|图片|视频|音频|文本|文件)，[^，）]+(?:，[^）]*)?）$/u

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
  const listed = splitList(text)
  // 早于附件清单的历史消息只有拼入的文字、没有清单：照样去掉文字（这类消息没有卡片）。
  const uploadedText = listed.text.indexOf(UPLOADED_TEXT_HEADER)
  return { text: uploadedText >= 0 ? listed.text.slice(0, uploadedText) : listed.text, attachments: listed.attachments }
}

function splitList(text: string): { text: string; attachments: MessageAttachment[] } {
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
