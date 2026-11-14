"""R8：企业端顶栏所需的「我是谁」——GET /api/manager/me 与开通时写入企业名。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

from manager_service.me_service import MeService, mask_account
from manager_service.routes_me import build_me_router

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
TENANT = "11111111-1111-4111-8111-111111111111"


class _Settings:
    def __init__(self, name):
        self.name = name

    def get_settings(self, ctx):
        return None if self.name is None else SimpleNamespace(enterprise_name=self.name)


class _Auth:
    def __init__(self, summary):
        self.summary = summary

    def find_account_summary(self, ctx, *, user_id):
        return self.summary


def _svc(
    *, name: str | None = "星河科技", code: str | None = "acme",
    summary: tuple[str, bool] | None = ("13812345678", True),
):
    return MeService(settings=_Settings(name), auth=_Auth(summary), registry_code=lambda tenant_id: code)


def _ctx(roles=("member",)):
    return TenantContext(tenant_id=TENANT, user_id="u-1", roles=list(roles))


def test_me_returns_enterprise_account_and_policy():
    data = _svc().get(_ctx(("enterprise_admin",)))
    assert data["enterprise_name"] == "星河科技"
    assert data["enterprise_code"] == "acme"
    assert data["account_masked"] == "138****5678"
    assert data["roles"] == ["enterprise_admin"]
    assert data["has_password"] is True
    assert set(data["password_policy"]) >= {"min_length", "require_upper", "require_lower", "require_digit", "require_symbol"}


def test_me_never_exposes_full_account_or_secret():
    data = _svc().get(_ctx())
    assert "13812345678" not in repr(data)


@pytest.mark.parametrize("stored", [None, ""])
def test_me_without_name_returns_none_so_ui_falls_back_to_code(stored):
    data = _svc(name=stored).get(_ctx())
    assert data["enterprise_name"] is None
    assert data["enterprise_code"] == "acme"


def test_me_for_oauth_only_account_has_no_password():
    data = _svc(summary=("oauth-sub-1", False)).get(_ctx())
    assert data["has_password"] is False


def test_me_missing_account_or_registry_is_tolerated():
    data = _svc(code=None, summary=None).get(_ctx())
    assert data["enterprise_code"] is None
    assert data["account_masked"] == "" and data["has_password"] is False


@pytest.mark.parametrize("raw,masked", [
    ("13812345678", "138****5678"),
    ("zhangsan", "z***"),
    ("ab", "a*"),
    ("", ""),
])
def test_mask_account(raw, masked):
    assert mask_account(raw) == masked


def _client(service):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/x"), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._me_service = service
    app.include_router(build_me_router(_VERIFIER))
    return TestClient(app)


def _hdr(roles):
    return {"Authorization": f"Bearer {sign_inmem_token(_SIGNER, '00000000-0000-4000-8000-000000000001', list(roles))}"}


def test_route_requires_token():
    assert _client(_svc()).get("/api/manager/me").status_code == 401


@pytest.mark.parametrize("role", ["member", "finance_admin", "enterprise_admin", "owner"])
def test_route_open_to_every_role(role):
    r = _client(_svc()).get("/api/manager/me", headers=_hdr([role]))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["enterprise_code"] == "acme"


def test_me_reports_tenant_status_and_tolerates_read_failure():
    """顶栏据此提示“企业已暂停，仅可查看”；状态读不到时按正常处理，不让整个页面失败。"""
    assert _svc().get(_ctx())["tenant_status"] == "active"
    suspended = MeService(
        settings=_Settings("星河科技"), auth=_Auth(("a", True)), registry_code=lambda t: "acme",
        tenant_status=lambda tenant_id: "suspended",
    )
    assert suspended.get(_ctx())["tenant_status"] == "suspended"

    def boom(tenant_id):
        raise RuntimeError("control db down")

    broken = MeService(settings=_Settings("x"), auth=_Auth(("a", True)), registry_code=lambda t: None, tenant_status=boom)
    assert broken.get(_ctx())["tenant_status"] == "active"


def test_route_reads_tenant_status_from_the_guard_store(monkeypatch):
    from shared.app_factory import create_app
    from manager_service import routes_me
    from manager_service.app import router as manager_router

    monkeypatch.setattr(routes_me, "SettingsRepository", lambda router: _Settings("星河科技"))
    monkeypatch.setattr(routes_me, "TenantAuthRepository", lambda router: _Auth(("a", True)))
    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/x"), manager_router)
    app.state._token_verifier = _VERIFIER
    app.include_router(build_me_router(_VERIFIER))
    app.state._tenant_status_store = SimpleNamespace(get=lambda tenant_id: "suspended")
    r = TestClient(app).get("/api/manager/me", headers=_hdr(["member"]))
    assert r.status_code == 200, r.text
    assert r.json()["data"]["tenant_status"] == "suspended"
