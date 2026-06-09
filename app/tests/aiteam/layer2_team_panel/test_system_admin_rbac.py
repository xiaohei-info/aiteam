from __future__ import annotations

import json

import pytest

from team_panel.repositories.audit_event_repo import AuditEventRepo
from tests.aiteam.layer0_contracts.test_host_routing import _get, _patch, _post


@pytest.mark.parametrize(
    ("path", "role", "expected_status", "expected_error"),
    [
        ("/api/system-admin/templates", "system_operator", 200, None),
        ("/api/system-admin/solutions", "system_operator", 200, None),
        ("/api/system-admin/finance/overview", "system_operator", 200, None),
        ("/api/system-admin/finance/reports", "system_admin", 200, None),
        ("/api/system-admin/enterprises", "system_admin", 200, None),
        ("/api/system-admin/quota", "system_operator", 501, "not_implemented"),
    ],
)
def test_system_read_paths_allow_system_roles_to_reach_current_contract(
    path: str, role: str, expected_status: int, expected_error: str | None
) -> None:
    status, body = _get(f"{path}?role={role}")
    assert status == expected_status, body
    assert body.get("error") == expected_error
    assert body.get("required_action") is None


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/system-admin/templates?role=system_operator", {"name": "Draft"}),
        ("/api/system-admin/solutions?role=system_operator", {"name": "Solution"}),
        ("/api/system-admin/enterprises/ent_1/actions?role=system_operator", {"action": "ban"}),
    ],
)
def test_system_operator_cannot_access_system_write_post_paths(path: str, payload: dict) -> None:
    status, body = _post(path, payload)
    assert status == 403, body
    assert body.get("error") == "FORBIDDEN"
    assert body.get("required_action") == "system_write"
    assert body.get("role") == "system_operator"


@pytest.mark.parametrize(
    ("path", "role"),
    [
        ("/api/system-admin/templates", "owner"),
        ("/api/system-admin/solutions", "enterprise_admin"),
        ("/api/system-admin/finance/overview", "finance_admin"),
        ("/api/system-admin/finance/reports", "member"),
        ("/api/system-admin/enterprises", "owner"),
        ("/api/system-admin/enterprises/export", "enterprise_admin"),
        ("/api/system-admin/enterprises/ent_1", "finance_admin"),
        ("/api/system-admin/enterprises/ent_1/quota", "member"),
    ],
)
def test_enterprise_roles_cannot_access_system_admin_read_paths(path: str, role: str) -> None:
    status, body = _get(f"{path}?role={role}")
    assert status == 403, body
    assert body.get("error") == "FORBIDDEN"
    assert body.get("required_action") == "system_read"
    assert body.get("role") == role


@pytest.mark.parametrize(
    ("path", "role", "payload"),
    [
        ("/api/system-admin/enterprises/ent_1/actions", "owner", {"action": "ban"}),
        ("/api/system-admin/enterprises/ent_1/quota", "enterprise_admin", {"employee_quota": 20}),
        ("/api/system-admin/templates", "finance_admin", {"name": "Draft"}),
    ],
)
def test_enterprise_roles_cannot_access_system_admin_write_paths(path: str, role: str, payload: dict) -> None:
    status, body = _post(f"{path}?role={role}", payload)
    assert status == 403, body
    assert body.get("error") == "FORBIDDEN"
    assert body.get("required_action") == "system_write"
    assert body.get("role") == role


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/api/system-admin/templates?role=system_admin",
            {
                "name": "Draft",
                "role_name": "运营专家",
                "category_code": "ops",
                "default_model_ref": {"provider": "openai", "model": "gpt-4o-mini"},
            },
        ),
        (
            "/api/system-admin/solutions?role=system_admin",
            {"name": "Solution", "template_ids": []},
        ),
    ],
)
def test_system_admin_write_post_paths_pass_rbac_and_execute_current_contract(path: str, payload: dict) -> None:
    status, body = _post(path, payload)
    assert status == 201, body
    assert body.get("required_action") is None


@pytest.mark.parametrize(
    ("path", "role", "expected_status"),
    [
        ("/api/system-admin/templates/tpl_1", "system_operator", 403),
        ("/api/system-admin/templates/tpl_1", "system_admin", 404),
        ("/api/system-admin/solutions/sol_1", "system_operator", 403),
        ("/api/system-admin/solutions/sol_1", "system_admin", 404),
    ],
)
def test_patch_paths_enforce_system_write(path: str, role: str, expected_status: int) -> None:
    status, body = _patch(f"{path}?role={role}", {"status": "published"})
    assert status == expected_status, body
    if expected_status == 403:
        assert body.get("error") == "FORBIDDEN"
        assert body.get("required_action") == "system_write"
        assert body.get("role") == role
    else:
        expected_error = "TEMPLATE_NOT_FOUND" if "/templates/" in path else "SOLUTION_NOT_FOUND"
        assert body.get("error") == expected_error
        assert body.get("required_action") is None


@pytest.mark.parametrize(
    ("action", "event_type", "expected_status"),
    [
        ("ban", "enterprise.suspended", "suspended"),
        ("recharge", "enterprise.recharge_recorded", "active"),
        ("notify", "enterprise.notify_recorded", "active"),
    ],
)
def test_system_admin_enterprise_actions_persist_audit_events(
    seeded_enterprise, db_conn, action: str, event_type: str, expected_status: str
) -> None:
    enterprise_id = seeded_enterprise["enterprise_id"]
    status, body = _post(
        f"/api/system-admin/enterprises/{enterprise_id}/actions?role=system_admin&actor_id=usr_sys",
        {
            "action": action,
            "reason": "governance review",
            "amount": "500",
            "amount_cents": 50000,
            "message": "manual follow-up",
            "request_id": f"req_{action}",
        },
    )

    assert status == 200, body
    assert body.get("enterprise_id") == enterprise_id
    assert body.get("action") == action
    assert body.get("status") == "succeeded"
    assert body.get("message")
    assert body.get("audit_event_id")

    cur = db_conn.cursor()
    try:
        event = AuditEventRepo(cur).get_by_id(body["audit_event_id"])
        assert event is not None
        assert event.event_type == event_type
        assert event.target_type == "enterprise"
        assert event.target_id == enterprise_id
        payload = json.loads(event.payload_json)
        assert payload["action"] in {"suspend", "recharge", "notify"}
        assert payload["reason"] == "governance review"
        if action == "ban":
            assert payload["previous_status"] == "active"
            assert payload["current_status"] == "suspended"
        else:
            assert payload["enterprise_status"] == "active"
    finally:
        cur.close()


def test_system_admin_unban_reactivates_enterprise_and_persists_audit(seeded_enterprise, db_conn) -> None:
    enterprise_id = seeded_enterprise["enterprise_id"]
    cur = db_conn.cursor()
    try:
        cur.execute(
            "UPDATE enterprise SET status = %s, archive_reason = %s WHERE id = %s",
            ("suspended", "policy", enterprise_id),
        )
        db_conn.commit()
    finally:
        cur.close()

    status, body = _post(
        f"/api/system-admin/enterprises/{enterprise_id}/actions?role=system_admin&actor_id=usr_sys",
        {"action": "unban", "reason": "resolved"},
    )
    assert status == 200, body
    assert body.get("enterprise_id") == enterprise_id
    assert body.get("action") == "unban"
    assert body.get("status") == "succeeded"
    assert body.get("audit_event_id")

    cur = db_conn.cursor()
    try:
        event = AuditEventRepo(cur).get_by_id(body["audit_event_id"])
        assert event is not None
        assert event.event_type == "enterprise.reactivated"
        payload = json.loads(event.payload_json)
        assert payload["previous_status"] == "suspended"
        assert payload["current_status"] == "active"
    finally:
        cur.close()


def test_system_admin_unban_from_active_returns_conflict_without_audit(seeded_enterprise, db_conn) -> None:
    enterprise_id = seeded_enterprise["enterprise_id"]
    status, body = _post(
        f"/api/system-admin/enterprises/{enterprise_id}/actions?role=system_admin&actor_id=usr_sys",
        {"action": "unban", "reason": "noop"},
    )
    assert status == 409, body
    assert body.get("error") == "ENTERPRISE_ACTION_CONFLICT"
    assert body.get("action") == "unban"

    cur = db_conn.cursor()
    try:
        events = AuditEventRepo(cur).list_by_target("enterprise", enterprise_id, limit=20)
        assert events == []
    finally:
        cur.close()


def test_system_health_remains_available_without_role_hint() -> None:
    status, body = _get("/api/system-admin/health")
    assert status == 200, body
    assert body.get("status") in {"ok", "partial", "unavailable"}
