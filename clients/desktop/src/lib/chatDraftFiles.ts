import type { CachedFile } from './fileCache'

/** Same as the input box's snapshot: the cloned nodes of the draft's @ mentions. */
export type DraftMentionSnapshot = readonly Node[]

export interface ConversationDraft {
  text: string
  files: CachedFile[]
  mentionSnapshot?: DraftMentionSnapshot
}

export type DraftsByConv = Record<string, ConversationDraft>

const EMPTY_DRAFT: ConversationDraft = { text: '', files: [] }

function clientIdOf(file: CachedFile): string | undefined {
  return (file as { upload?: { clientId?: string } }).upload?.clientId
}

function fileKey<T extends CachedFile>(file: T): string | T {
  return clientIdOf(file) ?? (file as { path?: string }).path ?? file
}

/**
 * Puts a failed send's attachments back without dropping the ones added while it was in flight:
 * sending is not allowed to take attachments away from the input box.
 */
export function mergeDraftFiles<T extends CachedFile>(restored: readonly T[], current: readonly T[]): T[] {
  const taken = new Set<string | T>(restored.map(fileKey))
  return [...restored, ...current.filter((file) => !taken.has(fileKey(file)))]
}

/**
 * One copy per conversation: a conversation's attachments live only in its draft, which is what the
 * input box shows. Every change (adding, import/upload progress, removal) goes through here, so an
 * import that finishes while the input box is closed is not lost and cannot be shadowed by a stale
 * copy when the box opens again.
 */
export function withDraftFiles(
  drafts: DraftsByConv,
  convId: string,
  update: (files: CachedFile[]) => CachedFile[],
): { drafts: DraftsByConv; files: CachedFile[] } {
  const draft = drafts[convId] ?? EMPTY_DRAFT
  const files = update(draft.files)
  if (files === draft.files) return { drafts, files }
  return { drafts: { ...drafts, [convId]: { ...draft, files } }, files }
}

/** Saves only the text (conversation switch, send): attachments are not the composer's to clear. */
export function withDraftText(
  drafts: DraftsByConv,
  convId: string,
  text: string,
  mentionSnapshot?: DraftMentionSnapshot,
): DraftsByConv {
  const draft = drafts[convId] ?? EMPTY_DRAFT
  return { ...drafts, [convId]: { ...draft, text, mentionSnapshot } }
}

/**
 * `emp_…` becoming a real conversation is the same conversation: its draft — including attachments
 * still being imported or uploaded — moves to the new id instead of being stranded on the old one.
 */
export function migrateDraftConversationId(
  drafts: DraftsByConv,
  oldId: string,
  newConvId: string,
): DraftsByConv {
  const moved = drafts[oldId]
  if (!moved || oldId === newConvId) return drafts
  const next = { ...drafts }
  delete next[oldId]
  const existing = next[newConvId]
  if (!existing) {
    next[newConvId] = moved
    return next
  }
  const taken = new Set(existing.files.map(clientIdOf).filter(Boolean))
  next[newConvId] = {
    text: existing.text || moved.text,
    files: [...moved.files.filter((file) => !taken.has(clientIdOf(file))), ...existing.files],
    mentionSnapshot: existing.mentionSnapshot ?? moved.mentionSnapshot,
  }
  return next
}
