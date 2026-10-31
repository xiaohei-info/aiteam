export interface KnowledgeSearchAvailability {
  enabled: boolean
  reason: string
  status: 'gone'
}

export const KNOWLEDGE_FULL_TEXT_SEARCH_AVAILABILITY: KnowledgeSearchAvailability = {
  enabled: false,
  status: 'gone',
  reason: '知识库全文搜索接口当前返回 410，摘要、高亮与结果定位契约尚未提供；当前输入框仅筛选已加载文档的文件名。',
}
