/** 组织树节点（对齐 server agent_service/workspace/service.py:OrgTreeNode）。 */
export interface OrgTreeNode {
  id: string;
  type: "department" | "employee" | string;
  name: string;
  parent_id?: string | null;
  status?: string | null;
  role?: string | null;
  children?: OrgTreeNode[];
}
