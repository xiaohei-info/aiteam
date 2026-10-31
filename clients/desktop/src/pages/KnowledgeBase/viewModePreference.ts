export type PersistedViewMode = 'list' | 'grid'

export const KB_DOCUMENT_VIEW_MODE_STORAGE_KEY = 'aifred:kb:documents:view-mode'

interface ViewModeStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readKnowledgeDocumentViewMode(
  storage: ViewModeStorage | null | undefined,
): PersistedViewMode {
  if (!storage) return 'list'
  try {
    return storage.getItem(KB_DOCUMENT_VIEW_MODE_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

export function writeKnowledgeDocumentViewMode(
  storage: ViewModeStorage | null | undefined,
  mode: PersistedViewMode,
): boolean {
  if (!storage) return false
  try {
    storage.setItem(KB_DOCUMENT_VIEW_MODE_STORAGE_KEY, mode)
    return true
  } catch {
    return false
  }
}
