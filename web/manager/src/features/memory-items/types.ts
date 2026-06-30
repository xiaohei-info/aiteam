export interface MemoryItem { memory_id: string; employee_id: string; content: string; category: string; importance: number; source: string; created_at: string; last_used_at: string | null; }
export interface MemoryCreate { employee_id: string; content: string; category?: string; importance?: number; }
