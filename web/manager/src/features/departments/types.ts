/** 部门管理视图类型：与 Manager DepartmentOut / DepartmentCreate / DepartmentUpdate 对齐。 */

export interface Department {
  id: string;
  department_slug: string;
  display_name: string;
  created_at: string | null;
  /** 上级部门 id；顶级部门为 null。旧版 Manager 不返回该字段。 */
  parent_id?: string | null;
}

export interface CreateDepartmentInput {
  department_slug: string;
  display_name: string;
  parent_id?: string;
}

export interface UpdateDepartmentInput {
  display_name?: string;
  /** null 表示移到顶级；省略表示不移动。 */
  parent_id?: string | null;
}

export interface DeleteDepartmentResult {
  deleted: string;
}
