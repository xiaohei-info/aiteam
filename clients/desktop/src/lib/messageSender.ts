/**
 * messageSender.ts — 消息发送层
 */

import { buildTextMessage } from './message'
import type { Message, MessageAttachment } from '../stores/chat'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SendContext {
  convId: string
  appendMessage: (convId: string, msg: Message) => void
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function dispatch(ctx: SendContext, msg: Message): void {
  ctx.appendMessage(ctx.convId, msg)
}

// ── Public send methods ───────────────────────────────────────────────────────

export function sendTextMessage(ctx: SendContext, text: string, attachments?: MessageAttachment[]): Message | null {
  const trimmed = text.trim()
  if (!trimmed && !attachments?.length) return null
  const msg: Message = { ...buildTextMessage(trimmed, 'user'), attachments: attachments?.length ? attachments : undefined }
  dispatch(ctx, msg)
  return msg
}

/** 将 Blob 读取为 base64 字符串(不含 data URI 前缀) */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
