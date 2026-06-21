/**
 * 成员级授权页类型（W-M.4）。
 *
 * 与后端契约对齐（不重定义）：member_grant 资源类型为 expert | solution（知识授权走
 * knowledge_space_binding，另一套，不在本页）。授权目标为 部门/成员。
 */

export type GrantResourceType = "expert" | "solution";

/** 成员级授权（对齐 MemberGrantOut）。 */
export interface Grant {
  id: string;
  resource_type: string;
  resource_id: string;
  department_ids: string[];
  member_ids: string[];
}

/** 创建/替换授权入参（对齐 MemberGrantCreate）。 */
export interface CreateGrantInput {
  resource_type: GrantResourceType;
  resource_id: string;
  department_ids: string[];
  member_ids: string[];
}

/** 改授权目标入参（对齐 MemberGrantUpdate）。 */
export interface UpdateGrantInput {
  department_ids: string[];
  member_ids: string[];
}

/** 选择器选项：成员 / 部门 / 专家实例 / 方案实例。 */
export interface Member {
  id: string;
  display_name: string;
}
export interface Department {
  id: string;
  display_name: string;
}
export interface ExpertOption {
  employee_id: string;
  display_name: string;
}
export interface SolutionOption {
  id: string;
  display_name: string;
}
