export interface StreamSnapshot {
  assistantMsgId: string
  content: string
  thinking: string
}

export interface StreamEntry {
  convId: string
  runId: string
  cancel: () => void
  onDelta: (text: string) => void
  onThinkingDelta: (text: string) => void
  getSnapshot: () => StreamSnapshot
  onSettled?: () => void
}

class StreamRegistry {
  private readonly entries = new Map<string, StreamEntry>()

  add(entry: StreamEntry): void {
    this.entries.set(entry.convId, entry)
  }

  remove(convId: string): void {
    this.entries.delete(convId)
  }

  has(convId: string): boolean {
    return this.entries.has(convId)
  }

  get(convId: string): StreamEntry | undefined {
    return this.entries.get(convId)
  }
}

export const streamRegistry = new StreamRegistry()
