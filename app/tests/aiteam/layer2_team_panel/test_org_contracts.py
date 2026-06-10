from __future__ import annotations

import uuid

from tests.aiteam.layer0_contracts.test_host_routing import _get, _patch


def _insert_department(db_conn, enterprise_id: str, department_id: str, name: str, parent_id: str | None = None) -> None:
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO department (id, enterprise_id, parent_id, name, visibility_scope, sort_order) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (department_id, enterprise_id, parent_id, name, "enterprise", 1),
        )
        db_conn.commit()
    finally:
        cur.close()


def test_org_tree_returns_nested_departments_and_members(seeded_enterprise, db_conn):
    enterprise_id = seeded_enterprise["enterprise_id"]
    _insert_department(db_conn, enterprise_id, "dept_ops", "运营部")
    _insert_department(db_conn, enterprise_id, "dept_ops_sub", "渠道组", parent_id="dept_ops")

    status, body = _get("/api/team/org/tree")
    assert status == 200, body
    assert body["enterprise"]["enterprise_id"] == enterprise_id
    assert isinstance(body["departments"], list)
    assert isinstance(body["unassigned_members"], list)
    assert "stats" in body

    root = next(item for item in body["departments"] if item["department_id"] == "dept_marketing")
    assert root["name"] == "市场部"
    assert isinstance(root["members"], list)
    assert root["member_count"] >= 1
    assert any(member["employee_id"] == seeded_enterprise["employee_id"] for member in root["members"])

    ops = next(item for item in body["departments"] if item["department_id"] == "dept_ops")
    assert ops["children"][0]["department_id"] == "dept_ops_sub"


def test_org_tree_returns_unassigned_members(seeded_enterprise, db_conn):
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            ("emp_unassigned", seeded_enterprise["enterprise_id"], seeded_enterprise["template_id"], "emp-unassigned", "Unassigned", "待命成员", "active", "talent_market"),
        )
        db_conn.commit()
    finally:
        cur.close()

    status, body = _get("/api/team/org/tree")
    assert status == 200, body
    assert any(member["employee_id"] == "emp_unassigned" for member in body["unassigned_members"])
    assert body["stats"]["unassigned_employee_count"] >= 1


def test_org_assignment_patch_updates_department_and_position(seeded_enterprise, db_conn):
    enterprise_id = seeded_enterprise["enterprise_id"]
    _insert_department(db_conn, enterprise_id, "dept_strategy", "策略部")

    status, body = _patch(
        f"/api/team/org/assignments/{seeded_enterprise['employee_id']}",
        {"department_id": "dept_strategy", "position_title": "策略分析师"},
    )
    assert status == 200, body
    assert body["employee_id"] == seeded_enterprise["employee_id"]
    assert body["department_id"] == "dept_strategy"
    assert body["position_title"] == "策略分析师"
    assert body["department"]["department_id"] == "dept_strategy"
    assert body["department"]["name"] == "策略部"


def test_org_assignment_patch_rejects_invalid_field(seeded_enterprise):
    status, body = _patch(
        f"/api/team/org/assignments/{seeded_enterprise['employee_id']}",
        {"department_name": "市场部"},
    )
    assert status == 400, body
    assert body["error"] == "INVALID_FIELD"


def test_org_assignment_patch_rejects_unknown_department(seeded_enterprise):
    status, body = _patch(
        f"/api/team/org/assignments/{seeded_enterprise['employee_id']}",
        {"department_id": f"dept_missing_{uuid.uuid4().hex[:6]}"},
    )
    assert status == 404, body
    assert body["error"] == "DEPARTMENT_NOT_FOUND"


def test_org_assignment_patch_rejects_empty_patch(seeded_enterprise):
    status, body = _patch(f"/api/team/org/assignments/{seeded_enterprise['employee_id']}", {})
    assert status == 400, body
    assert body["error"] == "MISSING_BODY" or body["error"] == "EMPTY_PATCH"
