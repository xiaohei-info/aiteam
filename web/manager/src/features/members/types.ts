/**
 * 成员账号页类型（W-M.2）。
 *
 * 仅前端视图所需形状；不重定义后端契约（与 /api/manager/members、/departments 的
 * MemberOut/MemberCreate/MemberUpdate、DepartmentOut 字段对齐，由调用方按 operation_id 消费）。
 */

/** 成员（不含凭据，对齐后端 MemberOut）。 */
export interface Member {
  id: string;
  display_name: string;
  status: string; // active | disabled
  roles: string[]; // EnterpriseRole 取值字符串
  department_ids: string[];
}

/** 部门（对齐后端 DepartmentOut，仅取页面所需字段）。 */
export interface Department {
  id: string;
  display_name: string;
}

/** 建成员入参（对齐后端 MemberCreate）。 */
export interface CreateMemberInput {
  account: string;
  initial_password: string;
  display_name: string;
  roles: string[];
  department_ids: string[];
}

/** 改成员入参（对齐后端 MemberUpdate；字段可选）。 */
export interface UpdateMemberInput {
  display_name?: string;
  roles?: string[];
  department_ids?: string[];
  status?: string; // active | disabled
}
