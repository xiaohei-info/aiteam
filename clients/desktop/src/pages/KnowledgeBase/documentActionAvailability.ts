export type KnowledgeDocumentAction =
  | 'select_multiple'
  | 'batch_move'
  | 'batch_delete'
  | 'batch_download'
  | 'rename'
  | 'delete'

export interface KnowledgeDocumentActionAvailability {
  action: KnowledgeDocumentAction
  enabled: false
  reason: string
}

export const KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON =
  '当前服务未开放知识文档管理操作。'

const ACTIONS: readonly KnowledgeDocumentAction[] = [
  'select_multiple',
  'batch_move',
  'batch_delete',
  'batch_download',
  'rename',
  'delete',
]

export const KNOWLEDGE_DOCUMENT_ACTION_AVAILABILITY: Readonly<
  Record<KnowledgeDocumentAction, KnowledgeDocumentActionAvailability>
> = Object.freeze(Object.fromEntries(
  ACTIONS.map((action) => [action, Object.freeze({
    action,
    enabled: false as const,
    reason: KNOWLEDGE_DOCUMENT_ACTIONS_UNAVAILABLE_REASON,
  })]),
) as Record<KnowledgeDocumentAction, KnowledgeDocumentActionAvailability>)
