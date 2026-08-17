"""issue #265 v1 功能补全路由测试：billing / llm / settings / memory / connector / org / collab / audit。

使用 mock service 验证 401/503/happy path（非集成，无 DB）。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import AppError
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _build_app(db_url, router_builder):
    """构造带 verifier 的测试 app。"""
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(router_builder(_VERIFIER))
    return TestClient(app)


# ---- billing routes ----

def test_billing_balance_401():
    from manager_service.routes_billing import build_billing_router
    c = _build_app("postgresql://x", build_billing_router)
    r = c.get("/api/manager/billing/balance")
    assert r.status_code == 401

def test_billing_balance_ok():
    from manager_service.routes_billing import build_billing_router
    from manager_service.routes_billing import BillingBalanceOut
    from decimal import Decimal

    svc = MagicMock()
    svc.get_balance.return_value = {"balance": Decimal("100"), "estimated_tokens": 100000,
                                     "warning_threshold": Decimal("50"), "updated_at": datetime.utcnow()}
    with patch("manager_service.routes_billing._service", return_value=svc):
        c = _build_app("postgresql://x", build_billing_router)
        r = c.get("/api/manager/billing/balance", headers=_hdr())
    assert r.status_code == 200
    assert float(r.json()["data"]["balance"]) == 100.0

def test_billing_recharge_create():
    from manager_service.routes_billing import build_billing_router
    from decimal import Decimal

    svc = MagicMock()
    svc.create_recharge.return_value = {
        "recharge_id": "r-1", "amount": Decimal("10"), "payment_method": "mock_pay",
        "status": "success", "order_no": "R1", "token_credited": 10000,
        "created_at": datetime.utcnow(),
    }
    with patch("manager_service.routes_billing._service", return_value=svc):
        c = _build_app("postgresql://x", build_billing_router)
        r = c.post("/api/manager/billing/recharges", json={"amount": 10, "payment_method": "mock_pay"}, headers=_hdr())
    assert r.status_code == 200
    assert r.json()["data"]["status"] == "success"

# ---- llm routes ----

def test_llm_provider_list_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.list_providers.return_value = [{"provider_id": "p-1", "name": "OpenAI", "provider_key": "openai",
                                         "base_url": None, "is_active": True, "model_count": 0,
                                         "created_at": datetime.utcnow()}]
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.get("/api/manager/llm/providers", headers=_hdr())
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1

def test_llm_provider_create_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.create_provider.return_value = {"provider_id": "p-1", "name": "Test", "provider_key": "test",
                                         "base_url": None, "is_active": True, "model_count": 0,
                                         "created_at": datetime.utcnow()}
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.post("/api/manager/llm/providers", json={"name": "Test", "provider_key": "test"}, headers=_hdr())
    assert r.status_code == 200

# ---- settings routes ----

def test_settings_get_ok():
    from manager_service.routes_settings import build_settings_router
    svc = MagicMock()
    svc.get_settings.return_value = {"enterprise_name": "TestCo", "logo_url": None,
                                      "phone": None, "contact_email": "",
                                      "default_runtime": "hermes_acp", "invite_required": True,
                                      "member_approval": True, "max_employees": 100, "features": {},
                                      "updated_at": datetime.utcnow()}
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.get("/api/manager/settings", headers=_hdr())
    assert r.status_code == 200

def test_settings_patch_ok():
    from manager_service.routes_settings import build_settings_router
    svc = MagicMock()
    svc.patch_settings.return_value = {"enterprise_name": "NewName", "logo_url": None,
                                        "phone": None, "contact_email": "",
                                        "default_runtime": "hermes_acp", "invite_required": True,
                                        "member_approval": True, "max_employees": 100, "features": {},
                                        "updated_at": datetime.utcnow()}
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.patch("/api/manager/settings", json={"enterprise_name": "NewName"}, headers=_hdr())
    assert r.status_code == 200

# ---- connector ops routes ----

def test_connector_presets_ok():
    from manager_service.routes_connector_ops import build_connector_ops_router
    c = _build_app("postgresql://x", build_connector_ops_router)
    r = c.get("/api/manager/connectors/presets", headers=_hdr())
    assert r.status_code == 200
    assert len(r.json()) >= 5

def test_connector_test_ok():
    from manager_service.routes_connector_ops import build_connector_ops_router
    svc = MagicMock()
    svc.test_connector.return_value = {"connector_id": "slack", "success": True, "latency_ms": 42,
                                        "message": "ok"}
    with patch("manager_service.routes_connector_ops._service", return_value=svc):
        c = _build_app("postgresql://x", build_connector_ops_router)
        r = c.post("/api/manager/connectors/slack/test", headers=_hdr())
    assert r.status_code == 200
    assert r.json()["data"]["success"] is True

# ---- org routes ----

def test_org_tree_ok():
    from manager_service.routes_org import build_org_router
    svc = MagicMock()
    svc.build_tree.return_value = {"id": "root", "type": "department", "name": "企业",
                                    "parent_id": None, "status": None, "children": []}
    with patch("manager_service.routes_org._service", return_value=svc):
        c = _build_app("postgresql://x", build_org_router)
        r = c.get("/api/manager/org/tree", headers=_hdr())
    assert r.status_code == 200

# ---- audit routes ----

def test_audit_events_list_ok():
    from manager_service.routes_collab_audit import build_audit_router
    svc = MagicMock()
    svc.list_events.return_value = [{"event_id": "e-1", "event_type": "login", "actor_id": "u-1",
                                      "target_type": None, "target_id": None, "detail": {},
                                      "created_at": datetime.utcnow()}]
    with patch("manager_service.routes_collab_audit._service", return_value=svc):
        c = _build_app("postgresql://x", build_audit_router)
        r = c.get("/api/manager/audit-events", headers=_hdr())
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1

# ---- 503 when db not configured ----

@pytest.mark.parametrize("builder,path,method", [
    ("routes_billing", "/api/manager/billing/balance", "GET"),
    ("routes_llm", "/api/manager/llm/providers", "GET"),
    ("routes_settings", "/api/manager/settings", "GET"),
    ("routes_org", "/api/manager/org/tree", "GET"),
])
def test_no_db_503(builder, path, method):
    mod = __import__(f"manager_service.{builder}", fromlist=[f"build_{builder.replace('routes_', '')}_router"])
    name_map = {
        "routes_billing": "build_billing_router",
        "routes_llm": "build_llm_router",
        "routes_settings": "build_settings_router",
        "routes_memory_items": "build_memory_items_router",
        "routes_org": "build_org_router",
    }
    builder_fn = getattr(mod, name_map[builder])
    c = _build_app(None, builder_fn)
    r = c.request(method, path, headers=_hdr())
    assert r.status_code == 503

# ---- settings invites ----

def test_settings_invite_list_ok():
    from manager_service.routes_settings import build_settings_router
    svc = MagicMock()
    svc.list_invites.return_value = [{"invite_id": "i-1", "phone": "13800138000", "display_name": "Admin",
                                       "status": "pending", "created_at": datetime.utcnow()}]
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.get("/api/manager/settings/admin-invites", headers=_hdr())
    assert r.status_code == 200

def test_settings_invite_create_ok():
    from manager_service.routes_settings import build_settings_router
    svc = MagicMock()
    svc.create_invite.return_value = {"invite_id": "i-1", "phone": "13800138000", "display_name": "Admin",
                                       "status": "pending", "created_at": datetime.utcnow()}
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.post("/api/manager/settings/admin-invites", json={"phone": "13800138000", "display_name": "Admin"}, headers=_hdr())
    assert r.status_code == 200

def test_settings_invite_delete_ok():
    from manager_service.routes_settings import build_settings_router
    svc = MagicMock()
    svc.delete_invite.return_value = None
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.delete("/api/manager/settings/admin-invites/i-1", headers=_hdr())
    assert r.status_code == 204

def test_settings_invite_delete_404():
    from manager_service.routes_settings import build_settings_router
    from shared.errors import NotFound
    svc = MagicMock()
    svc.delete_invite.side_effect = NotFound("nope")
    with patch("manager_service.routes_settings._service", return_value=svc):
        c = _build_app("postgresql://x", build_settings_router)
        r = c.delete("/api/manager/settings/admin-invites/i-1", headers=_hdr())
    assert r.status_code == 404

# ---- settings_service ----

def test_settings_service_get_defaults():
    """get_settings 返回空 row 时调用 upsert。"""
    from manager_service.settings_service import SettingsService
    from manager_service.settings_repository import SettingsRepository
    from tests.manager._fake_router import FakeRouter, FakeCursor, ctx
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))  # get_settings SELECT → None
    # upsert_settings 内部: 1) SELECT id check → exists → skipped update; 2) final SELECT
    router.queue(FakeCursor(fetchone=("s-1",)))  # existing check returns id
    router.queue(FakeCursor(fetchone=("s-1", "DefaultCo", "", "", None, "hermes_acp", True, True, 100, {}, datetime.utcnow())))  # final SELECT
    svc = SettingsService(SettingsRepository(router))
    result = svc.get_settings(ctx())
    assert result["enterprise_name"] == "DefaultCo"

def test_settings_service_delete_invite_404():
    """delete_invite 返回 False 时抛 NotFound。"""
    from manager_service.settings_service import SettingsService
    from manager_service.settings_repository import SettingsRepository
    from tests.manager._fake_router import FakeRouter, FakeCursor, ctx
    from shared.errors import NotFound
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=0))  # delete → no rows
    svc = SettingsService(SettingsRepository(router))
    with pytest.raises(NotFound):
        svc.delete_invite(ctx(), "missing")

# ---- llm model routes ----

def test_llm_model_list_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.list_models.return_value = [{"model_id": "m-1", "provider_id": "p-1", "model_uid": "gpt-4", "model_name": "GPT-4",
                                      "context_window": 8192, "input_price": "0.03", "output_price": "0.06",
                                      "is_active": True}]
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.get("/api/manager/llm/models", headers=_hdr())
    assert r.status_code == 200

def test_llm_model_create_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.create_model.return_value = {"model_id": "m-1", "provider_id": "p-1", "model_uid": "gpt-4", "model_name": "GPT-4",
                                      "context_window": 8192, "input_price": "0.03", "output_price": "0.06",
                                      "is_active": True}
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.post("/api/manager/llm/providers/p-1/models", json={"model_uid": "gpt-4", "model_name": "GPT-4"}, headers=_hdr())
    assert r.status_code == 200

def test_llm_provider_delete_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.delete_provider.return_value = None
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.delete("/api/manager/llm/providers/p-1", headers=_hdr())
    assert r.status_code == 204

def test_llm_model_delete_ok():
    from manager_service.routes_llm import build_llm_router
    svc = MagicMock()
    svc.delete_model.return_value = None
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.delete("/api/manager/llm/models/m-1", headers=_hdr())
    assert r.status_code == 204

def test_llm_provider_delete_404():
    from manager_service.routes_llm import build_llm_router
    from shared.errors import NotFound
    svc = MagicMock()
    svc.delete_provider.side_effect = NotFound("nope")
    with patch("manager_service.routes_llm._service", return_value=svc):
        c = _build_app("postgresql://x", build_llm_router)
        r = c.delete("/api/manager/llm/providers/p-1", headers=_hdr())
    assert r.status_code == 404

# ---- org routes 补充 ----

def test_org_update_assignment_ok():
    from manager_service.routes_org import build_org_router
    svc = MagicMock()
    svc.update_assignment.return_value = {"assignment_id": "emp-1", "department_id": "dept-1", "updated": True}
    with patch("manager_service.routes_org._service", return_value=svc):
        c = _build_app("postgresql://x", build_org_router)
        r = c.patch("/api/manager/org/assignments/emp-1", json={"department_id": "dept-1"}, headers=_hdr())
    assert r.status_code == 200

def test_org_update_assignment_404():
    from manager_service.routes_org import build_org_router
    from shared.errors import NotFound
    svc = MagicMock()
    svc.update_assignment.side_effect = NotFound("nope")
    with patch("manager_service.routes_org._service", return_value=svc):
        c = _build_app("postgresql://x", build_org_router)
        r = c.patch("/api/manager/org/assignments/emp-1", json={"department_id": "dept-1"}, headers=_hdr())
    assert r.status_code == 404

# ---- employee export ----

def test_employee_export_ok():
    from manager_service.routes_employee import build_employee_router
    svc = MagicMock()
    mock_item = MagicMock()
    mock_item.employee_id = "e-1"
    mock_item.employee_slug = "expert-1"
    mock_item.display_name = "专家A"
    mock_item.model = "gpt-4"
    mock_item.runtime_binding = "hermes_acp"
    mock_item.skills = ["skill1", "skill2"]
    mock_item.version = 1
    svc.list_all.return_value = [mock_item]
    with patch("manager_service.routes_employee._service", return_value=svc):
        c = _build_app("postgresql://x", build_employee_router)
        r = c.get("/api/manager/employees/export/all", headers=_hdr())
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]

# ---- 401 补漏 ----

@pytest.mark.parametrize("builder,path,method", [
    ("routes_settings", "/api/manager/settings/admin-invites", "GET"),
    ("routes_settings", "/api/manager/settings/admin-invites", "POST"),
    ("routes_llm", "/api/manager/llm/models?provider_id=p-1", "GET"),
    ("routes_llm", "/api/manager/llm/providers/p-1/models", "POST"),
    ("routes_org", "/api/manager/org/assignments/emp-1", "PATCH"),
])
def test_401_missing_routes(builder, path, method):
    mod = __import__(f"manager_service.{builder}", fromlist=["x"])
    name_map = {
        "routes_settings": "build_settings_router",
        "routes_llm": "build_llm_router",
        "routes_org": "build_org_router",
    }
    builder_fn = getattr(mod, name_map[builder])
    c = _build_app("postgresql://x", builder_fn)
    r = c.request(method, path, json={"display_name": "x", "phone": "x", "model_uid": "x", "model_name": "x", "employee_id": "x", "department_id": "x"})
    assert r.status_code == 401
