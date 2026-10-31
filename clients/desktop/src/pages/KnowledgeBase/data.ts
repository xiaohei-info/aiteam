import type { KnowledgeBase, KnowledgeStats } from './types'

export const knowledgeStats: KnowledgeStats = {
  totalBases: 8,
  totalDocs: 1234,
  totalChunks: '48.6K',
  storageUsed: '2.1GB',
}

export const knowledgeBases: KnowledgeBase[] = [
  { id: '1', icon: '📋', name: 'AI培训资料库', docCount: 342, updatedAt: '今天', progress: 85, files: [
    { id: 'f1', name: 'AI基础培训.pdf', size: '2.3MB', type: 'pdf', uploadedAt: '2026-06-06' },
    { id: 'f2', name: '机器学习入门.docx', size: '1.1MB', type: 'docx', uploadedAt: '2026-06-05' },
  ]},
  { id: '2', icon: '📊', name: '公司内部资料', docCount: 156, updatedAt: '昨天', progress: 60, files: [
    { id: 'f3', name: '2026年度报告.pdf', size: '5.6MB', type: 'pdf', uploadedAt: '2026-06-05' },
  ]},
  { id: '3', icon: '📈', name: '竞品分析资料', docCount: 89, updatedAt: '3天前', progress: 45, files: [] },
  { id: '4', icon: '🔬', name: '行业研究报告', docCount: 234, updatedAt: '1周前', progress: 72, files: [] },
  { id: '5', icon: '📝', name: '合同模板库', docCount: 67, updatedAt: '2天前', progress: 30, files: [] },
  { id: '6', icon: '⚡', name: '技术文档', docCount: 346, updatedAt: '今天', progress: 90, files: [] },
]
