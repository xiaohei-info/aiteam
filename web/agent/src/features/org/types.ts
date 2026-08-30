/** 组织树节点（对齐 server agent_service/workspace/service.py:OrgTreeNode）。 */
export interface OrgTreeNode {
  id: string;
  type: "department" | "employee" | string;
  name: string;
  parent_id?: string | null;
  status?: string | null;
  role?: string | null;
  avatar_url?: string | null;
  /** Employee department assignment carried by Manager projections. */
  department_ids?: string[];
  children?: OrgTreeNode[];
}
