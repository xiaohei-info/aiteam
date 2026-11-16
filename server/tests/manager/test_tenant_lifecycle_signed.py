"""R5：Operator → Manager 的租户生命周期调用走真实签名链路（不注入合成主体）。

HttpManagerGateway → 签名的 ServiceClient → Manager 的 /tenants/{id}/status|purge 路由，
接收端用生产口径的验签器（强制范围 / 来源 / 目标绑定）和信任清单。
"""

from __future__ import annotations

import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from manager_service.routes_tenant import router as tenant_router
from operation_service.manager_gateway import HttpManagerGateway
from shared.auth import generate_rsa_keypair
from shared.errors import Forbidden, install_exception_handlers
from shared.service_client import ServiceClient
from shared.service_identity import ServiceIdentitySigner, ServiceIdentityVerifier

T = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
ORIGIN = "https://manager.invalid"
_PRIVATE_KEY, _PUBLIC_KEY = generate_rsa_keypair()
_ALL_SCOPES = ("enterprise:provision", "owner:bootstrap", "notification:write", "tenant:lifecycle")


class Store:
    def __init__(self, status="active"):
        self.status, self.set_calls, self.invalidated = status, [], []

    def record(self, tenant):
        return (self.status, None)

    def set_status(self, tenant, status, reason):
        self.set_calls.append((tenant, status, reason))
        self.status = status
        return True

    def invalidate(self, tenant):
        self.invalidated.append(tenant)


def _registration(scopes):
    now = int(time.time())
    return {
        "public_key": _PUBLIC_KEY, "issuer": "operation-issuer", "subject": "operation-service",
        "deployment_id": "operation-deployment", "audiences": ["aiteam-manager-service"],
        "origins": [ORIGIN], "scopes": list(scopes), "provisioning_capabilities": ["provision-enterprise"],
        "status": "active", "not_before": now - 30, "expires_at": now + 300,
        "target_bindings": [{"tenant_id": T, "origin": ORIGIN}],
    }


def _gateway(store, *, scopes=_ALL_SCOPES):
    registry = {"operation-key": _registration(scopes)}
    app = FastAPI()
    install_exception_handlers(app)
    app.state.settings = type("Settings", (), {
        "aiteam_env": "production", "service_name": "aiteam-manager-service",
        "service_identity_audience": "aiteam-manager-service", "service_identity_origin": ORIGIN,
        "service_identity_trust": registry, "service_token": "should-never-be-used",
        "admin_db_url": "postgresql://unused/unused",
    })()
    app.state.service_identity_verifier = ServiceIdentityVerifier(
        registry, expected_audience="aiteam-manager-service", expected_origin=ORIGIN,
        require_scope_binding=True, require_origin_binding=True, single_instance=True,
    )
    app.state._tenant_status_store = store
    app.include_router(tenant_router)

    def handler(request: httpx.Request) -> httpx.Response:
        with TestClient(app) as client:
            response = client.request(
                request.method, str(request.url), headers=dict(request.headers), content=request.content,
            )
        return httpx.Response(response.status_code, headers=response.headers, content=response.content)

    signer = ServiceIdentitySigner(
        _PRIVATE_KEY, kid="operation-key", issuer="operation-issuer", subject="operation-service",
        deployment_id="operation-deployment", ttl_seconds=30,
    )
    return HttpManagerGateway(ServiceClient(
        ORIGIN, service_identity="operation-service", service_signer=signer,
        service_audience="aiteam-manager-service", aiteam_env="production", transport=httpx.MockTransport(handler),
    ))


def test_signed_status_sync_reaches_the_manager_route():
    store = Store()
    gateway = _gateway(store)
    gateway.set_tenant_status(T, "suspended", reason="欠费", idempotency_key="status-1")
    gateway.set_tenant_status(T, "active", idempotency_key="status-2")  # 无 reason：请求体里没有该键
    assert store.set_calls == [(T, "suspended", "欠费"), (T, "active", None)]


def test_signed_purge_reaches_the_manager_route(monkeypatch):
    purged = []
    monkeypatch.setattr("manager_service.tenant_status.purge_tenant_data",
                        lambda dsn, tenant, root: purged.append(tenant) or {"employee": 2})
    monkeypatch.setattr("manager_service.knowledge_intake_service.manager_storage_root", lambda settings: None)
    store = Store(status="deleted")
    _gateway(store).purge_tenant(T, idempotency_key="purge-1")
    assert purged == [T] and store.invalidated == [T]


def test_trust_registry_without_lifecycle_scope_is_rejected():
    """信任清单没登记 tenant:lifecycle 时，暂停 / 封禁 / 注销 / 删除一律 403（上线前置条件）。"""
    store = Store()
    gateway = _gateway(store, scopes=("enterprise:provision", "owner:bootstrap", "notification:write"))
    with pytest.raises(Forbidden):
        gateway.set_tenant_status(T, "suspended", idempotency_key="status-3")
    assert store.set_calls == []


def test_signed_status_sync_for_an_unbound_tenant_is_rejected():
    store = Store()
    with pytest.raises(Forbidden):
        _gateway(store).set_tenant_status(OTHER, "banned", idempotency_key="status-4")
    assert store.set_calls == []
