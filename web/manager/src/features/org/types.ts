export interface OrgTreeNode { id: string; type: string; name: string; parent_id: string | null; status: string | null; children: OrgTreeNode[]; }
