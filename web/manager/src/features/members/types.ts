/**
 * 成员账号页类型（W-M.2）。
 *
 * 仅前端视图所需形状；不重定义后端契约（与 /api/manager/members、/departments 的
 * MemberOut/MemberCreate/MemberUpdate、DepartmentOut 字段对齐，由调用方按 operation_id 消费）。
 */

import type { EnterpriseRole } from "@aiteam/shared";

/** 成员（不含凭据，对齐后端 MemberOut）。 */
export interface Member {
  id: string;
  display_name: string;
  status: MemberStatus;
  roles: EnterpriseRole[];
  department_ids: string[];
}

export type MemberStatus = "active" | "disabled";

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
  roles: EnterpriseRole[];
  department_ids: string[];
}

/** 改成员入参（对齐后端 MemberUpdate；字段可选）。 */
export interface UpdateMemberInput {
  display_name?: string | null;
  roles?: EnterpriseRole[];
  department_ids?: string[];
  status?: MemberStatus;
}
