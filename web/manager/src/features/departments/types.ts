/** 部门管理视图类型：与 Manager DepartmentOut / DepartmentCreate / DepartmentUpdate 对齐。 */

export interface Department {
  id: string;
  department_slug: string;
  display_name: string;
  created_at: string | null;
}

export interface CreateDepartmentInput {
  department_slug: string;
  display_name: string;
}

export interface UpdateDepartmentInput {
  display_name: string;
}

export interface DeleteDepartmentResult {
  deleted: string;
}
