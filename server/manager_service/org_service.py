"""组织树编排（P07 + B01）。

从 department / app_user / employee 表构建 OrgTreeNode。
"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Forbidden, NotFound

_ORG_WRITE_ROLES = frozenset({"owner", "enterprise_admin"})
UNASSIGNED_DEPARTMENT_ID = "unassigned"


class OrgService:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def build_tree(self, ctx: TenantContext) -> dict:
        """从 department + employee 构建组织树。

        返回根节点（type=department），children 包含部门子树和挂员工节点。
        """
        with self._router.session(ctx) as s:
            # 取所有部门
            dept_rows = s.execute(
                "SELECT id, department_slug, display_name FROM department ORDER BY department_slug",
            ).fetchall()
            # 取所有员工（含 department_ids）
            emp_rows = s.execute(
                "SELECT e.id, e.employee_slug, e.display_name, e.department_ids, e.role_title "
                "FROM employee e ORDER BY e.display_name",
            ).fetchall()

        # 构建部门节点。组织树根下只允许部门节点，员工永远挂在部门节点下。
        dept_nodes = {}
        for r in dept_rows:
            department_id = str(r[0])
            dept_nodes[department_id] = {
                "id": department_id, "type": "department", "name": r[2] or r[1],
                "parent_id": "root", "status": None, "children": [],
            }

        # 员工归属到部门；历史数据中的空值或无效部门 id 统一归入“未设置”。
        unassigned_employees = []
        for r in emp_rows:
            emp_id = str(r[0])
            dept_ids = [str(department_id) for department_id in (r[3] or [])]
            assigned_ids = [department_id for department_id in dept_ids if department_id in dept_nodes]
            if assigned_ids:
                for department_id in assigned_ids:
                    dept_nodes[department_id]["children"].append({
                        "id": emp_id, "type": "employee", "name": r[2] or r[1],
                        "parent_id": department_id, "status": None, "role_title": r[4], "children": [],
                    })
            else:
                unassigned_employees.append({
                    "id": emp_id, "type": "employee", "name": r[2] or r[1],
                    "parent_id": UNASSIGNED_DEPARTMENT_ID, "status": None, "role_title": r[4], "children": [],
                })

        # 构建树：根节点 → 部门 → 员工；未设置也是一个合成部门节点。
        root = {
            "id": "root", "type": "department", "name": "企业",
            "parent_id": None, "status": None, "children": [],
        }
        root["children"].extend(dept_nodes.values())
        if unassigned_employees:
            root["children"].append({
                "id": UNASSIGNED_DEPARTMENT_ID,
                "type": "department",
                "name": "未设置",
                "parent_id": "root",
                "status": None,
                "children": unassigned_employees,
            })

        return root

    def update_assignment(self, ctx: TenantContext, employee_id: str, department_id: str) -> dict:
        """调整员工部门归属。"""
        if not set(ctx.roles) & _ORG_WRITE_ROLES:
            raise Forbidden("organization assignment requires owner or enterprise_admin")
        with self._router.session(ctx) as s:
            # 验证部门存在
            dept = s.execute("SELECT id FROM department WHERE id = %s", (department_id,)).fetchone()
            if dept is None:
                raise NotFound("department not found in this tenant")
            # 验证员工存在
            emp = s.execute("SELECT id FROM employee WHERE id = %s", (employee_id,)).fetchone()
            if emp is None:
                raise NotFound("employee not found in this tenant")
            # 更新 employee.department_ids（追加到列表）
            s.execute(
                "UPDATE employee SET department_ids = array_append(department_ids, %s) "
                "WHERE id = %s AND NOT (%s = ANY(department_ids))",
                (department_id, employee_id, department_id),
            )
        return {"assignment_id": employee_id, "department_id": department_id, "updated": True}
