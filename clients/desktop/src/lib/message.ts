function nowStamp(): { time: string; _ts: number } {
  const d = new Date()
  return {
    time: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
    _ts: d.getTime(),
  }
}

export function buildTextMessage(text: string, role: 'user' | 'assistant') {
  const stamp = nowStamp()
  return {
    id: crypto.randomUUID(),
    role,
    msgType: 'text' as const,
    content: text,
    time: stamp.time,
    _ts: stamp._ts,
    status: 'sending' as const,
  }
}
