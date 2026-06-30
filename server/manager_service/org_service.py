"""组织树编排（P07 + B01）。

从 department / app_user / employee 表构建 OrgTreeNode。
"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import NotFound


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
                "SELECT e.id, e.employee_slug, e.display_name, e.department_ids "
                "FROM employee e ORDER BY e.display_name",
            ).fetchall()

        # 构建部门节点
        dept_nodes = {}
        for r in dept_rows:
            dept_nodes[str(r[0])] = {
                "id": str(r[0]), "type": "department", "name": r[2] or r[1],
                "parent_id": None, "status": None, "children": [],
            }

        # 员工归属到部门
        unassigned_employees = []
        for r in emp_rows:
            emp_id = str(r[0])
            emp_node = {
                "id": emp_id, "type": "employee", "name": r[2] or r[1],
                "parent_id": None, "status": None, "children": [],
            }
            dept_ids = list(r[3]) if r[3] else []
            assigned = False
            for did in dept_ids:
                if did in dept_nodes:
                    dept_nodes[did]["children"].append(emp_node)
                    assigned = True
            if not assigned:
                unassigned_employees.append(emp_node)

        # 构建树：根节点 → 部门 → 员工
        root = {
            "id": "root", "type": "department", "name": "企业",
            "parent_id": None, "status": None, "children": [],
        }
        for dn in dept_nodes.values():
            root["children"].append(dn)
        root["children"].extend(unassigned_employees)

        return root

    def update_assignment(self, ctx: TenantContext, employee_id: str, department_id: str) -> dict:
        """调整员工部门归属。"""
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
