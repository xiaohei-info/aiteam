export interface MemoryItem { memory_id: string; employee_id: string; content: string; category: string; importance: number | null; source: string; created_at: string | null; last_used_at: string | null; state?: "valid" | "invalidated" | string; }
export interface MemoryCreate { employee_id: string; content: string; category?: string; importance?: number; }

export interface MemoryEmployeeAnalytics {
  employee_id: string;
  display_name: string;
  memory_count: number;
  state_counts: Record<string, number>;
  category_counts: Record<string, number>;
  latest_created_at: string | null;
  oldest_created_at: string | null;
  latest_used_at: string | null;
  average_importance: number | null;
  max_importance: number | null;
  total_nodes?: number | null;
  total_links?: number | null;
  total_documents?: number | null;
  total_observations?: number | null;
  pending_operations?: number | null;
  failed_operations?: number | null;
  pending_consolidation?: number | null;
  failed_consolidation?: number | null;
  last_memory_write_at?: string | null;
  last_consolidated_at?: string | null;
  truncated: boolean;
}

export interface MemoryAnalytics {
  status: "available" | "partial" | "unavailable" | "not_configured";
  employee_count: number;
  total_memory_count: number;
  refreshed_at: string;
  employees: MemoryEmployeeAnalytics[];
  unavailable_employee_count: number;
}
