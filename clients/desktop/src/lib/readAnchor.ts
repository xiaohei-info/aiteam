interface ReadAnchorEntry {
  entry_ref?: string | null
  id?: string | null
}

// `null` 会清空服务端已读锚点，因此只有最后一条真实 entry 带有效 id 时才允许上报。
export function getLastReadEntryId(entries: readonly ReadAnchorEntry[]): string | null {
  const entry = entries[entries.length - 1]
  const id = entry?.entry_ref ?? entry?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}
