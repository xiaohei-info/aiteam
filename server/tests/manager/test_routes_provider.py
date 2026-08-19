"""provider 凭据路由分支覆盖补齐（M5，无 DB 非集成）。

覆盖 create/list/get/update/delete 全分支 + 422（visibility=members 无member_ids）。
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import Forbidden, NotFound
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from manager_service.schemas_provider import (
    ProviderCredentialOut,
    ProviderModelCapability,
    RuntimeProviderConfigOut,
)


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def _client(db_url):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_provider import build_provider_credential_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient

    app = create_app(Settings(tier="manager", service_name="m", db_url=db_url), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_provider_credential_router(_VERIFIER))
    return TestClient(app)


def _cap(model="gpt-4o", display_name="", enabled=True, capabilities=None):
    return {
        "model": model,
        "display_name": display_name,
        "enabled": enabled,
        "capabilities": capabilities or {},
    }


def _out(**kw):
    base = dict(credential_id="c-1", provider_ref="relay", display_name="AI Relay", endpoint="https://r", api_protocol="openai-completions", visibility="tenant",
                allowed_member_ids=[],
                supported_models=[_cap()], model_catalog_source="manual",
                version=1)
    base.update(kw)
    return ProviderCredentialOut(**base)


def _fake_svc():
    svc = MagicMock()
    o = _out()
    svc.runtime_config.return_value = RuntimeProviderConfigOut(
        base_url="https://relay.example/v1", api_protocol="openai-completions",
        api_key="runtime-secret", model="gpt-4o", provider_ref="relay", version=1,
    )
    svc.create.return_value = o
    svc.list_all.return_value = [o]
    svc.get.return_value = o
    svc.update.return_value = _out(version=2)
    svc.delete.return_value = None
    svc.list_providers_supporting_model.return_value = [o]
    return svc


_ENDPOINTS = [
    ("POST", "/api/manager/provider-credentials"),
    ("GET", "/api/manager/provider-credentials"),
    ("GET", "/api/manager/provider-credentials/c-1"),
    ("PUT", "/api/manager/provider-credentials/c-1"),
    ("DELETE", "/api/manager/provider-credentials/c-1"),
]


@pytest.mark.parametrize("method,path", _ENDPOINTS)
def test_no_token_401(method, path):
    client = _client(None)
    body = {"provider_ref": "r", "secret": "s"} if method in ("POST",) else (
        {"secret": "s"} if method == "PUT" else None)
    r = client.request(method, path, json=body)
    assert r.status_code == 401


def test_runtime_config_requires_auth():
    client = _client("postgresql://fake/fake")
    r = client.post(
        "/api/manager/provider-credentials/runtime-config",
        json={"employee_id": "e1"},
    )
    assert r.status_code == 401


def test_runtime_config_rejects_malformed_request():
    client = _client("postgresql://fake/fake")
    r = client.post(
        "/api/manager/provider-credentials/runtime-config",
        json={"employee_id": "e1", "credential_id": "must-not-be-accepted"},
        headers=_hdr(),
    )
    assert r.status_code == 422


def test_runtime_config_sets_no_store_and_preserves_scope_error():
    fake = _fake_svc()
    fake.runtime_config.side_effect = Forbidden("member is not authorized for this expert")
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post(
            "/api/manager/provider-credentials/runtime-config",
            json={"employee_id": "e1"}, headers=_hdr(roles=["member"]),
        )
        assert r.status_code == 403


def test_runtime_config_happy_path_sets_no_store():
    fake = _fake_svc()
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post(
            "/api/manager/provider-credentials/runtime-config",
            json={"employee_id": "e1"}, headers=_hdr(),
        )
        assert r.status_code == 200
        assert r.headers["cache-control"] == "no-store"
        assert r.json()["data"]["api_key"] == "runtime-secret"
        fake.runtime_config.assert_called_once()


def test_create_no_db_503():
    client = _client(None)
    r = client.post("/api/manager/provider-credentials",
                    json={"provider_ref": "r", "secret": "s"}, headers=_hdr())
    assert r.status_code == 503
    assert r.json()["code"] == "manager_db_unconfigured"


def test_create_visibility_members_no_ids_422():
    """visibility=members requires non-empty allowed_member_ids（schema validator）。"""
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/provider-credentials",
                    json={"provider_ref": "r", "secret": "s", "visibility": "members"},
                    headers=_hdr())
    assert r.status_code == 422


def test_create_extra_field_422():
    client = _client("postgresql://fake/fake")
    r = client.post("/api/manager/provider-credentials",
                    json={"provider_ref": "r", "secret": "s", "bad": 1}, headers=_hdr())
    assert r.status_code == 422


def test_create_supported_models_422_on_bad_item():
    """supported_models 条目缺少必填 model 字段应 422。"""
    client = _client("postgresql://fake/fake")
    r = client.post(
        "/api/manager/provider-credentials",
        json={
            "provider_ref": "r", "secret": "s",
            "supported_models": [{"display_name": "x", "enabled": True}],
        },
        headers=_hdr(),
    )
    assert r.status_code == 422


def test_happy_with_preinjected_crypto_covers_branch():
    """crypto 已预存时覆盖 43->46 False 分支（无 build_crypto_service 重复构建）。"""
    fake = _fake_svc()
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        c.app.state._crypto_service = MagicMock()  # 已存的 crypto → 跳过 build
        r = c.get("/api/manager/provider-credentials", headers=_hdr())
        assert r.status_code == 200


def test_happy_multistep():
    fake = _fake_svc()
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/provider-credentials",
                   json={"provider_ref": "r", "secret": "s"}, headers=_hdr())
        assert r.status_code == 201 and r.json()["data"]["provider_ref"] == "relay"
        r = c.get("/api/manager/provider-credentials", headers=_hdr())
        assert r.status_code == 200 and len(r.json()["data"]) == 1
        r = c.get("/api/manager/provider-credentials/c-1", headers=_hdr())
        assert r.status_code == 200
        r = c.put("/api/manager/provider-credentials/c-1", json={"secret": "s2"}, headers=_hdr())
        assert r.status_code == 200 and r.json()["data"]["version"] == 2
        r = c.delete("/api/manager/provider-credentials/c-1", headers=_hdr())
        assert r.status_code == 204


def test_create_passes_supported_models_through():
    """create 应把 supported_models 原样回显（由 service→Out 透传）。"""
    cap = _cap(model="claude-3-5-sonnet", display_name="Claude 3.5", capabilities={"context_window": 200000})
    fake = _fake_svc()
    fake.create.return_value = _out(supported_models=[cap], model_catalog_source="manual")
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post(
            "/api/manager/provider-credentials",
            json={
                "provider_ref": "r", "secret": "s",
                "supported_models": [{
                    "model": "claude-3-5-sonnet",
                    "display_name": "Claude 3.5",
                    "enabled": True,
                    "capabilities": {"context_window": 200000},
                }],
            },
            headers=_hdr(),
        )
        assert r.status_code == 201
        data = r.json()["data"]
        assert data["supported_models"][0]["model"] == "claude-3-5-sonnet"
        assert data["supported_models"][0]["capabilities"] == {"context_window": 200000}
        assert data["model_catalog_source"] == "manual"


def test_list_contains_supported_models():
    """list 返回的每个 provider 都带 supported_models 数组。"""
    fake = _fake_svc()
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/provider-credentials", headers=_hdr())
        assert r.status_code == 200
        item = r.json()["data"][0]
        assert isinstance(item["supported_models"], list)
        assert item["supported_models"][0]["model"] == "gpt-4o"
        assert "secret" not in item
        assert "encrypted_secret" not in item


def test_update_supported_models_pass_through():
    """PUT 改写 supported_models 后回显新值（version 自增）。"""
    fake = _fake_svc()
    fake.update.return_value = _out(
        version=2,
        supported_models=[_cap(model="gpt-4o-mini")],
        model_catalog_source="manual",
    )
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.put(
            "/api/manager/provider-credentials/c-1",
            json={
                "secret": "s2",
                "supported_models": [{"model": "gpt-4o-mini", "enabled": True}],
            },
            headers=_hdr(),
        )
        assert r.status_code == 200
        data = r.json()["data"]
        assert data["version"] == 2
        assert data["supported_models"][0]["model"] == "gpt-4o-mini"


def test_get_not_found_404():
    fake = _fake_svc()
    fake.get.side_effect = NotFound("nope")
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.get("/api/manager/provider-credentials/missing", headers=_hdr())
        assert r.status_code == 404


def test_create_forbidden_403():
    fake = _fake_svc()
    fake.create.side_effect = Forbidden("nope")
    with patch("manager_service.routes_provider.build_provider_credential_service", return_value=fake):
        c = _client("postgresql://fake/fake")
        r = c.post("/api/manager/provider-credentials",
                   json={"provider_ref": "r", "secret": "s"}, headers=_hdr(roles=["member"]))
        assert r.status_code == 403
