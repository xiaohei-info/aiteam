export interface MemoryItem { memory_id: string; employee_id: string; content: string; category: string; importance: number | null; source: string; created_at: string | null; last_used_at: string | null; state?: "valid" | "invalidated"; }
export interface MemoryCreate { employee_id: string; content: string; category?: string; importance?: number; }
