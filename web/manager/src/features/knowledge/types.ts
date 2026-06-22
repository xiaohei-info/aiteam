export interface KnowledgeSpace {
  knowledge_space_id: string;
  workspace: string;
  display_name: string;
  created_at?: string | null;
}
export interface KnowledgeSpaceCreate { knowledge_space_id: string; display_name?: string; }
export interface KnowledgeBinding {
  id: string; tenant_id: string; knowledge_space_id: string;
  resource_type: string; resource_id: string; created_at?: string | null;
}
export interface BindingCreate {
  resource_type: "expert" | "department" | "member"; resource_id: string;
}
