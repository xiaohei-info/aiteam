export interface KnowledgeBase { kb_id: string; name: string; description: string; doc_count: number; size_kb: number; source_type: string; sync_status: string; }
export interface KnowledgeSearchResult { doc_id: string; title: string; snippet: string; score: number; }
