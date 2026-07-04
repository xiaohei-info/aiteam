"""F03 目录发布通知收端测试（POST /api/manager/catalog/notify，Operator→Manager 云侧调用）。

验证：service-token 守卫（AITEAM-331 fail-closed）、请求体校验、正常通知接收。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer
from manager_service.app import router as manager_router
from manager_service.routes_catalog_notify import router as catalog_notify_router
from manager_service.operator_catalog import FakeOperatorCatalogClient

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _client(*, service_token=None):
    app = create_app(
        Settings(tier="manager", service_name="m", service_token=service_token),
        manager_router,
    )
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(catalog_notify_router)
    return TestClient(app)


def _body(**kw):
    base = {
        "catalog_type": "expert_template",
        "template_id": "tpl-cmo",
        "version": "1",
        "action": "published",
    }
    base.update(kw)
    return base


# ---- service-token 守卫（AITEAM-331 fail-closed）----

def test_notify_no_service_token_configured_401():
    """未配置 SERVICE_TOKEN → fail-closed 401（AITEAM-331 B2）。"""
    client = _client()
    r = client.post("/api/manager/catalog/notify", json=_body())
    assert r.status_code == 401


def test_notify_no_service_token_in_prod_401():
    """生产模式（SERVICE_TOKEN 配置强密钥）无 X-Service-Token → 401。"""
    client = _client(service_token="prod-strong-secret")
    r = client.post("/api/manager/catalog/notify", json=_body())
    assert r.status_code == 401


def test_notify_wrong_service_token_in_prod_401():
    client = _client(service_token="prod-strong-secret")
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "wrong"},
    )
    assert r.status_code == 401


def test_notify_dev_prefix_fails_closed():
    """dev-* 前缀 token 不再视为 dev，仍需严格校验（AITEAM-331 B2）。"""
    client = _client(service_token="dev-mykey")
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "wrong"},
    )
    assert r.status_code == 401


def test_notify_correct_service_token_in_prod_200():
    client = _client(service_token="prod-strong-secret")
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["received"] is True


# ---- dev profile（占位值）fail-open ----

def test_notify_dev_placeholder_fail_open_200():
    """唯一允许的 dev 占位值 → fail-open 200。"""
    client = _client(service_token="dev-service-token-placeholder")
    r = client.post("/api/manager/catalog/notify", json=_body())
    assert r.status_code == 200
    assert r.json()["data"]["template_id"] == "tpl-cmo"
    assert r.json()["data"]["action"] == "published"


# ---- 请求体校验 ----

def test_notify_missing_fields_422():
    client = _client(service_token="prod-strong-secret")
    r = client.post(
        "/api/manager/catalog/notify",
        json={"template_id": "x"},
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 422


def test_notify_extra_field_422():
    """CatalogReleaseNotify 的 extra=forbid → 多余字段拒绝。"""
    client = _client(service_token="prod-strong-secret")
    r = client.post(
        "/api/manager/catalog/notify",
        json={**_body(), "extra": 1},
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 422


# ---- 各 action 均可接收 ----

@pytest.mark.parametrize("action", ["published", "unpublished", "visibility_changed"])
def test_notify_all_actions(action):
    client = _client(service_token="prod-strong-secret")
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(action=action),
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["action"] == action


# ---- invalidate 路径覆盖（routes_catalog_notify.py 分支覆盖）----

class _CatalogWithInvalidate:
    """带 invalidate 方法的最小 catalog stub，用于测试分支覆盖。"""
    def __init__(self, *, raise_on_invalidate: bool = False):
        self.invalidated: list[tuple[str, str]] = []
        self._raise = raise_on_invalidate

    def invalidate(self, catalog_type: str, template_id: str) -> None:
        if self._raise:
            raise RuntimeError("invalidate failed")
        self.invalidated.append((catalog_type, template_id))


def _client_with_catalog(catalog, *, service_token="prod-strong-secret"):
    from shared.app_factory import create_app
    from shared.config import Settings
    from manager_service.app import router as manager_router

    app = create_app(
        Settings(tier="manager", service_name="m", service_token=service_token),
        manager_router,
    )
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = catalog
    app.include_router(catalog_notify_router)
    return TestClient(app)


def test_notify_calls_invalidate_when_available():
    """catalog 暴露 invalidate → 调用并记录。"""
    catalog = _CatalogWithInvalidate()
    client = _client_with_catalog(catalog)
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 200
    assert catalog.invalidated == [("expert_template", "tpl-cmo")]


def test_notify_swallows_invalidate_exception():
    """catalog.invalidate 抛异常 → 仍返回 200（best-effort）。"""
    catalog = _CatalogWithInvalidate(raise_on_invalidate=True)
    client = _client_with_catalog(catalog)
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["received"] is True


def test_notify_no_invalidate_method_still_succeeds():
    """catalog 没有 invalidate 方法 → 跳过失效，仍返回 200。"""
    class _NoInvalidate:
        pass

    client = _client_with_catalog(_NoInvalidate())
    r = client.post(
        "/api/manager/catalog/notify",
        json=_body(),
        headers={"X-Service-Token": "prod-strong-secret"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["received"] is True
