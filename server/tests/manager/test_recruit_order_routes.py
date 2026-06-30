"""routes_recruit 招募订单路由验收（AITEAM-243）。"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas import RecruitmentOrderOut


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_recruit import build_recruit_router
    from manager_service.routes_employee import build_employee_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_recruit_router(_VERIFIER))
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _fake_order(order_id="ro-1"):
    return RecruitmentOrderOut(
        order_id=order_id, idempotency_key="k-1", action="recruit_expert",
        template_id="t-1", solution_id=None, requested_by="u-1",
        created_employee_id="emp-1", status="succeeded",
        error_code=None, error_message=None,
    )


def test_list_orders_requires_auth():
    client = _client("postgresql://fake/fake")
    r = client.get("/api/manager/recruit/orders")
    assert r.status_code == 401


def test_get_order_requires_auth():
    client = _client("postgresql://fake/fake")
    r = client.get("/api/manager/recruit/orders/ro-1")
    assert r.status_code == 401


def test_list_orders_unconfigured_db_503():
    client = _client(None)
    r = client.get("/api/manager/recruit/orders", headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_list_orders_happy():
    fake = type("FakeNS", (), {})()
    fake.list_recruit_orders = lambda ctx: [_fake_order()]
    fake.get_recruit_order = lambda ctx, order_id: _fake_order(order_id)
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/orders", headers=_hdr())
        assert r.status_code == 200
        data = r.json()["data"]
        assert len(data) == 1 and data[0]["status"] == "succeeded"
        assert data[0]["action"] == "recruit_expert"


def test_get_order_happy():
    fake = type("FakeNS", (), {})()
    fake.list_recruit_orders = lambda ctx: []
    fake.get_recruit_order = lambda ctx, order_id: _fake_order(order_id)
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/recruit/orders/ro-xyz", headers=_hdr())
        assert r.status_code == 200
        assert r.json()["data"]["order_id"] == "ro-xyz"
