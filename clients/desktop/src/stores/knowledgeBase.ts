import { create } from 'zustand'
import { KNOWLEDGE_BASE_WRITE_AVAILABILITY } from '../lib/serviceWriteAvailability'
import type { KnowledgeBase, KnowledgeStats, KbFile } from '../pages/KnowledgeBase/types'
import { knowledgeBases as initialList, knowledgeStats as initialStats } from '../pages/KnowledgeBase/data'

interface KnowledgeBaseState {
  stats: KnowledgeStats
  list: KnowledgeBase[]
  addKnowledgeBase: (kb: Omit<KnowledgeBase, 'id'>) => void
  getFiles: (kbId: string) => KbFile[]
  addFiles: (kbId: string, files: KbFile[]) => void
  removeFile: (kbId: string, fileId: string) => void
}

function rejectLocalKnowledgeWrite(): never {
  throw new Error(KNOWLEDGE_BASE_WRITE_AVAILABILITY.reason)
}

export const useKnowledgeBaseStore = create<KnowledgeBaseState>((_, get) => ({
  stats: initialStats,
  list: initialList,

  addKnowledgeBase: rejectLocalKnowledgeWrite,

  getFiles: (kbId) => get().list.find((kb) => kb.id === kbId)?.files ?? [],

  addFiles: rejectLocalKnowledgeWrite,

  removeFile: rejectLocalKnowledgeWrite,
}))
