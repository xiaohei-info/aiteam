"""employee lifecycle 路由分支覆盖（issue #281）：DB-less happy-path + 错误传播。

mock 注入 EmployeeConfigService.transition / .get；不依赖 PG。测试：
- create 后 status = draft（新字段）
- transition happy-path（provision → activate / pause → resume / archive 透 reason）
- 状态机不合法 → 409 Conflict（service 抛 Conflict）
- 跨 tenant / 不存在 employee → 404
- archive 缺少 reason → 422 validation
- lifecycle options 接口透出 allowed_transitions + is_runnable / is_provisionable
- archived 配置写 → 403（service 抛 Forbidden）
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Conflict, Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import EmployeeConfigOut


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _auth_header(roles=("owner",), user_id="u1", tenant_id="t1"):
    token = sign_inmem_token(_SIGNER, tenant_id, list(roles), user_id=user_id)
    return {"Authorization": f"Bearer {token}"}


def _client(db_url="postgresql://fake/fake"):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service", db_url=db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _base_out(**overrides) -> EmployeeConfigOut:
    base = dict(
        employee_id="emp-1",
        employee_slug="exp-1",
        display_name="专家A",
        version=1,
        status="draft",
    )
    base.update(overrides)
    return EmployeeConfigOut(**base)


# ---- default status on create ----

def test_create_employee_default_status_draft():
    """新创建的 employee 默认 status = draft（issue #281 补齐状态字段）。"""
    fake = MagicMock()
    fake.create.return_value = _base_out()
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        resp = client.post(
            "/api/manager/employees?employee_slug=exp-1",
            json={"display_name": "专家A"},
            headers=_auth_header(),
        )
        assert resp.status_code == 201
        assert resp.json()["data"]["status"] == "draft"


# ---- transitions: happy-paths ----

def test_transition_provision_then_activate():
    fake = MagicMock()
    fake.get.return_value = _base_out()
    fake.transition.side_effect = [
        _base_out(status="provisioning"),
        _base_out(status="active", version=2),
    ]
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r1 = client.post(
            "/api/manager/employees/emp-1/transitions/provision",
            headers=_auth_header(),
        )
        assert r1.status_code == 200, r1.text
        assert r1.json()["data"]["status"] == "provisioning"

        r2 = client.post(
            "/api/manager/employees/emp-1/transitions/activate",
            headers=_auth_header(),
        )
        assert r2.status_code == 200
        assert r2.json()["data"]["status"] == "active"
        assert fake.transition.call_count == 2


def test_transition_pause_resume():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    fake.transition.side_effect = [
        _base_out(status="paused"),
        _base_out(status="active"),
    ]
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r1 = client.post(
            "/api/manager/employees/emp-1/transitions/pause",
            headers=_auth_header(),
        )
        assert r1.status_code == 200
        assert r1.json()["data"]["status"] == "paused"

        r2 = client.post(
            "/api/manager/employees/emp-1/transitions/resume",
            headers=_auth_header(),
        )
        assert r2.status_code == 200
        assert r2.json()["data"]["status"] == "active"


def test_transition_archive_requires_reason():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    fake.transition.return_value = _base_out(
        status="archived",
        archive_reason="contract ended",
        archived_at="2026-06-30T12:00:00Z",
    )
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.post(
            "/api/manager/employees/emp-1/transitions/archive",
            json={"reason": "contract ended"},
            headers=_auth_header(),
        )
        assert r.status_code == 200
        assert r.json()["data"]["status"] == "archived"
        assert r.json()["data"]["archive_reason"] == "contract ended"


def test_transition_archive_missing_reason_422():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.post(
            "/api/manager/employees/emp-1/transitions/archive",
            headers=_auth_header(),
        )
        assert r.status_code == 422
        assert r.json()["code"] == "lifecycle_validation_error"


# ---- error propagation ----

def test_transition_invalid_from_state_machine_409():
    """active 上 pause 非法（状态机拒绝 → service 抛 Conflict → 409）。"""
    from unittest.mock import patch
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    fake.transition.side_effect = Conflict("transition 'pause' not allowed from status=active")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.post(
            "/api/manager/employees/emp-1/transitions/pause",
            headers=_auth_header(),
        )
        assert r.status_code == 409
        assert r.json()["code"] == "conflict"


def test_transition_not_found_404():
    fake = MagicMock()
    fake.get.side_effect = NotFound("employee not found in this tenant")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.get(
            "/api/manager/employees/missing/transitions",
            headers=_auth_header(),
        )
        assert r.status_code == 404


def test_transition_member_forbidden_403():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    fake.transition.side_effect = Forbidden("archived employee cannot be modified")
    # 403 仅可能在 archived 配置写被 enforce；此处直接测侧通道
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.post(
            "/api/manager/employees/emp-1/transitions/pause",
            headers=_auth_header(),
        )
        assert r.status_code == 403


def test_transition_no_verifier_token_401():
    fake = MagicMock()
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.post("/api/manager/employees/emp-1/transitions/provision")
        assert r.status_code == 401


# ---- lifecycle options endpoint ----

def test_lifecycle_options_active_contains_pause_and_archive():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="active")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.get(
            "/api/manager/employees/emp-1/transitions",
            headers=_auth_header(),
        )
        assert r.status_code == 200
        body = r.json()["data"]
        assert body["status"] == "active"
        assert "pause" in body["allowed_transitions"]
        assert "archive" in body["allowed_transitions"]
        assert "resume" not in body["allowed_transitions"]
        assert body["is_runnable"] is True
        assert body["is_provisionable"] is False


def test_lifecycle_options_draft_contains_provision_activate():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="draft")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.get(
            "/api/manager/employees/emp-1/transitions",
            headers=_auth_header(),
        )
        assert r.status_code == 200
        body = r.json()["data"]
        assert body["status"] == "draft"
        assert "provision" in body["allowed_transitions"]
        assert "activate" in body["allowed_transitions"]
        assert "pause" not in body["allowed_transitions"]
        assert body["is_runnable"] is False
        assert body["is_provisionable"] is True


def test_lifecycle_options_archived_terminal():
    fake = MagicMock()
    fake.get.return_value = _base_out(status="archived")
    with patch("manager_service.routes_employee.build_employee_config_service", return_value=fake):
        client = _client()
        r = client.get(
            "/api/manager/employees/emp-1/transitions",
            headers=_auth_header(),
        )
        assert r.status_code == 200
        body = r.json()["data"]
        assert body["status"] == "archived"
        assert body["allowed_transitions"] == []
        assert body["is_runnable"] is False
        assert body["is_provisionable"] is False
