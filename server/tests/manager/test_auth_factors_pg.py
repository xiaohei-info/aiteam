"""Real PG/RLS + registered auth/MFA routes; only upstream OAuth provider is synthetic."""
from contextlib import contextmanager
import uuid

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.auth_service import build_auth_service, LoginInput
from manager_service.active_principal import ActivePrincipalVerifier
from manager_service.auth_origin import AuthOrigin
from manager_service.oauth import OAuthConnectionStore, OAuthProfile
from manager_service.oauth_service import OAuthService
from manager_service.login_audit import LoginAuditRepository
from manager_service.routes_auth import router as auth_router
from manager_service.routes_mfa import passkey_router, passkey_mgmt_router, oauth_router, oauth_mgmt_router
from shared.app_factory import create_app
from shared.auth import RS256TokenVerifier, tenant_context_from
from shared.config import Settings
from shared.db import PgTenantRouter
from shared.errors import Conflict, Unauthorized
from .test_oauth_service import FakeProvider
from .test_passkey_ceremony import registration_payload, login_payload

pytestmark = pytest.mark.integration


@pytest.fixture
def auth_app(migrated_db, admin_url, two_tenants, monkeypatch):
    monkeypatch.setenv("MANAGER_PUBLIC_ORIGIN", "https://manager.example")
    tenant = two_tenants[0]
    auth = build_auth_service(migrated_db, admin_url)
    account = "fixture-" + uuid.uuid4().hex
    auth.create_member(tenant, phone=account, initial_password="Fixture-Pass-1", must_reset=False)
    result = auth.login(LoginInput(tenant_id=tenant, account=account, password="Fixture-Pass-1"))
    ctx = tenant_context_from(result.claims)
    router = PgTenantRouter(migrated_db)
    oauth = OAuthService(providers={"fakeprov": FakeProvider()}, connections=OAuthConnectionStore(router),
                         auth_repo=auth._repo, audit=LoginAuditRepository(router), issuer=auth.issue,
                         origin=AuthOrigin.parse("https://manager.example"))
    app = create_app(
        Settings(
            tier="manager",
            service_name="fixture",
            db_url=migrated_db,
            admin_db_url=admin_url,
            manager_tenant_id=tenant,
        ),
        APIRouter(),
    )
    app.state._auth_service, app.state._oauth_service = auth, oauth
    app.state._token_verifier = ActivePrincipalVerifier(
        RS256TokenVerifier.from_jwks(auth.jwks(tenant)),
        auth._repo,
        deployment_tenant_id=tenant,
        require_binding=True,
    )
    for route in [auth_router, passkey_router, passkey_mgmt_router, oauth_router, oauth_mgmt_router]:
        app.include_router(route)
    return TestClient(app), ctx, account, {"Authorization": "Bearer " + result.token}, router, oauth


def test_real_password_timestamps_reset_and_disabled_routes(auth_app):
    client, ctx, account, headers, router, _ = auth_app
    with router.session(ctx) as s:
        assert s.execute("SELECT password_changed_at FROM auth_identity WHERE user_id = %s", (ctx.user_id,)).fetchone()[0] is not None
        s.execute("UPDATE auth_identity SET password_changed_at = now() - interval '100 days' WHERE user_id = %s", (ctx.user_id,))
    body = {"tenant_id": ctx.tenant_id, "account": account, "password": "Fixture-Pass-1"}
    assert client.post("/api/auth/login", json=body).json()["code"] == "password_expired"
    reset = {"tenant_id": ctx.tenant_id, "account": account, "old_password": "Fixture-Pass-1", "new_password": "Fixture-Pass-2"}
    assert client.post("/api/auth/owner-reset", json=reset).status_code == 200
    assert client.post("/api/auth/login", json={**body, "password": "Fixture-Pass-2"}).status_code == 200
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'disabled' WHERE id = %s", (ctx.user_id,))
    assert client.post("/api/auth/login", json={**body, "password": "Fixture-Pass-2"}).json()["code"] == "principal_inactive"
    assert client.post("/api/auth/owner-reset", json={**reset, "old_password": "Fixture-Pass-2"}).json()["code"] == "principal_inactive"
    assert client.get("/api/manager/passkeys", headers=headers).json()["code"] == "principal_inactive"


def test_real_passkey_options_registration_login_and_disabled(auth_app):
    client, ctx, account, headers, router, _ = auth_app
    options = client.post("/api/manager/passkeys/registration-options", headers=headers)
    assert options.status_code == 200, options.text
    assert options.json()["data"]["rp"]["id"] == "manager.example"
    payload, key = registration_payload(options.json()["data"])
    response = client.post("/api/manager/passkeys", headers=headers, json=payload)
    assert response.status_code == 200, response.text
    cred_id = response.json()["data"]["credential_id"]
    def assertion():
        result = client.get("/api/auth/passkey/authentication-options", params={"tenant_id": ctx.tenant_id, "account": account})
        assert result.status_code == 200, result.text
        return {"tenant_id": ctx.tenant_id, **login_payload(result.json()["data"], key)}
    payload = assertion()
    login = client.post("/api/auth/passkey/login", json=payload)
    assert login.status_code == 200, login.text
    assert login.json()["data"]["claims"]["user_id"] == ctx.user_id
    assert client.post("/api/auth/passkey/login", json=payload).status_code == 422
    payload = assertion()
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'disabled' WHERE id = %s", (ctx.user_id,))
    assert client.post("/api/auth/passkey/login", json=payload).json()["code"] == "principal_inactive"
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'active' WHERE id = %s", (ctx.user_id,))
    assert client.delete("/api/manager/passkeys/" + cred_id, headers=headers).status_code == 200
    assert client.get("/api/manager/passkeys", headers=headers).json()["data"] == []


def test_oauth_registered_link_login_unlink_and_atomic_rollback(auth_app):
    client, ctx, _, headers, router, oauth = auth_app
    redirect = oauth.origin.oauth_redirect_uri
    body = {"provider": "fakeprov", "tenant_id": ctx.tenant_id, "redirect_uri": redirect, "intent": "link"}
    assert client.post("/api/auth/oauth/authorize", json=body).status_code == 401
    state = client.post("/api/auth/oauth/authorize", headers=headers, json=body).json()["data"]["state"]
    link = {"provider": "fakeprov", "code": "fixture", "redirect_uri": redirect, "state": state}
    assert client.post("/api/manager/oauth/link", headers=headers, json=link).status_code == 200
    assert client.post("/api/manager/oauth/link", headers=headers, json=link).status_code == 422
    def login():
        state = client.post("/api/auth/oauth/authorize", json={**body, "intent": "login"}).json()["data"]["state"]
        return client.post("/api/auth/oauth/callback", json={"provider": "fakeprov", "code": "fixture", "state": state})
    assert login().status_code == 200
    # Same upstream sub, different provider remains a distinct identity.
    oauth._connections.link(ctx, user_id=ctx.user_id, profile=OAuthProfile(provider="other", provider_user_id="sub-1"))
    assert oauth._connections.find(ctx, external_id="absent:sub-1") is None
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'disabled' WHERE id = %s", (ctx.user_id,))
    assert login().json()["code"] == "principal_inactive"
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'active' WHERE id = %s", (ctx.user_id,))
    class FailingRouter:
        @contextmanager
        def session(self, ctx):
            with router.session(ctx) as session:
                execute = session.execute
                def fail(sql, params=None):
                    result = execute(sql, params)
                    if sql.startswith("DELETE FROM auth_identity"):
                        raise RuntimeError("injected unlink failure")
                    return result
                session.execute = fail
                yield session
    with pytest.raises(RuntimeError):
        OAuthConnectionStore(FailingRouter()).delete(ctx, user_id=ctx.user_id, provider="fakeprov")
    assert login().status_code == 200  # both tables survived rollback
    assert client.delete("/api/manager/oauth/fakeprov", headers=headers).status_code == 200
    assert login().status_code == 401
    assert oauth._connections.find(ctx, external_id="other:sub-1") is not None
    with router.session(ctx) as s:
        assert s.execute("SELECT count(*) FROM auth_identity WHERE provider = 'oauth' AND external_id = 'fakeprov:sub-1'").fetchone()[0] == 0
        s.execute("DELETE FROM auth_identity WHERE provider IN ('phone', 'password') AND user_id = %s", (ctx.user_id,))
    with pytest.raises(Conflict, match="last one"):
        oauth.unlink(ctx, provider="other", user_id=ctx.user_id)


def test_factor_delete_ownership_and_last_method(auth_app, two_tenants):
    from manager_service.passkey_store import PasskeyStore
    from shared.contracts.tenancy import TenantContext
    client, ctx, _, headers, router, oauth = auth_app
    store = PasskeyStore(router)
    store.insert(ctx, user_id=ctx.user_id, credential_id="ownership-key", public_key_pem="fixture-public", sign_count=0, label="Own")
    auth = client.app.state._auth_service
    other = auth.create_member(ctx.tenant_id, phone="other-"+uuid.uuid4().hex, initial_password="Fixture-Pass-1", must_reset=False)
    other_token = auth.issue(ctx.tenant_id, other, ["member"]).token
    denied = client.delete("/api/manager/passkeys/ownership-key", headers={"Authorization": "Bearer "+other_token})
    assert denied.status_code == 404
    assert store.find_by_credential(ctx, "ownership-key") is not None
    foreign = TenantContext(tenant_id=two_tenants[1], user_id=ctx.user_id, roles=["owner"])
    assert store.delete(foreign, credential_id="ownership-key") is False
    assert store.find_by_credential(foreign, "ownership-key") is None
    oauth._connections.link(ctx, user_id=ctx.user_id, profile=OAuthProfile(provider="fakeprov", provider_user_id="ownership-sub"))
    assert client.delete("/api/manager/oauth/fakeprov", headers={"Authorization": "Bearer "+other_token}).json()["data"]["unlinked"] is False
    assert oauth._connections.find(ctx, external_id="fakeprov:ownership-sub") is not None
    assert oauth._connections.delete(foreign, provider="fakeprov", user_id=ctx.user_id) is False
    assert client.delete("/api/manager/oauth/fakeprov", headers=headers).status_code == 200
    with router.session(ctx) as s:
        s.execute("DELETE FROM auth_identity WHERE user_id = %s AND provider IN ('phone','password')", (ctx.user_id,))
    # Factor-only principal still has the passkey identity; removing its last credential must fail.
    auth._repo.find_or_create_passkey_identity(ctx, user_id=ctx.user_id)
    assert client.delete("/api/manager/passkeys/ownership-key", headers=headers).status_code == 409
    assert store.find_by_credential(ctx, "ownership-key") is not None


def test_existing_hindsight_lease_checks_active_member_in_real_route_assembly(auth_app, two_tenants, monkeypatch):
    import httpx
    from manager_service.hindsight_credentials import HindsightLeaseStore, derive_hindsight_bank_id
    from manager_service.hindsight_client import HindsightSettings
    from manager_service.routes_hindsight import build_hindsight_router
    from manager_service.repository import TenantAuthRepository
    client, ctx, _, _, router, _ = auth_app
    leases = HindsightLeaseStore()
    app = client.app
    app.state._hindsight_lease_store = leases
    from manager_service.employee_config_service import build_employee_config_service
    from manager_service.schemas import EmployeeConfigIn, MemberGrantCreate
    from manager_service.repository_member import MemberDeptRepository, GrantRepository
    from manager_service.member_service import GrantService
    admin = ctx.model_copy(update={"roles": ["owner"]})
    config = build_employee_config_service(router)
    employee = config.create(admin, EmployeeConfigIn(display_name="lease fixture"), employee_slug=uuid.uuid4().hex)
    config.transition(admin, employee_id=employee.employee_id, transition="activate")
    grants = GrantService(repo=GrantRepository(router), members=MemberDeptRepository(router))
    def authorize_member(member):
        grants.create_grant(admin, MemberGrantCreate(resource_type="expert", resource_id=employee.employee_id, member_ids=[member]))
    authorize_member(ctx.user_id)
    monkeypatch.setenv("HINDSIGHT_URL", "https://hindsight.invalid")
    monkeypatch.setenv("HINDSIGHT_SERVICE_TOKEN", "fixture-upstream")
    app.include_router(build_hindsight_router(app.state._token_verifier))
    seen = []
    original = httpx.AsyncClient
    def upstream(request):
        seen.append(request.url.path)
        return httpx.Response(200, json={"results": []})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(upstream)))
    def issue(tenant, member):
        bank = derive_hindsight_bank_id(tenant, member, employee.employee_id)
        return leases.issue(tenant_id=tenant, member_id=member, employee_id=employee.employee_id, snapshot_version="s1", policy={"enabled": True}, bank_id=bank)
    def call(lease):
        return client.post(f"/api/manager/hindsight/v1/default/banks/{lease.bank_id}/memories/recall", headers={"Authorization": "Bearer "+lease.token, "X-Member-ID": "spoofed"}, json={"query": "fixture"})
    lease = issue(ctx.tenant_id, ctx.user_id)
    assert call(lease).status_code == 200
    assert isinstance(app.state._hindsight_facade._principals, TenantAuthRepository)
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET status = 'disabled' WHERE id = %s", (ctx.user_id,))
    assert call(lease).json()["code"] == "principal_inactive"
    assert len(seen) == 1
    auth = app.state._auth_service
    other = auth.create_member(ctx.tenant_id, phone="lease-other-"+uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    authorize_member(other)
    assert call(issue(ctx.tenant_id, other)).status_code == 200
    assert call(issue(two_tenants[1], other)).status_code == 401
    with router.session(ctx) as s:
        s.execute("DELETE FROM app_user WHERE id = %s", (ctx.user_id,))
    assert call(lease).status_code == 401
    assert len(seen) == 2


@pytest.mark.parametrize("path,body,mutation", [
    ("skill-bindings", {"skill_id": "fixture"}, "PATCH"),
    ("knowledge-bindings", {"knowledge_space_id": "fixture", "enabled": False}, "PATCH"),
    ("connector-bindings", {"connector_id": "fixture"}, "PATCH"),
    ("prompt-versions", {"display_name": "fixture", "set_current": False}, "POST"),
])
def test_registered_binding_routes_bind_path_employee_to_real_resource(auth_app, path, body, mutation):
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_employee_bindings import build_employee_bindings_router
    client, ctx, _, headers, router, _ = auth_app
    verifier = client.app.state._token_verifier
    client.app.include_router(build_employee_router(verifier))
    client.app.include_router(build_employee_bindings_router(verifier))
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET roles = ARRAY['owner'] WHERE id = %s", (ctx.user_id,))
    employee = client.post("/api/manager/employees?employee_slug=binding-fixture", headers=headers, json={"display_name": "Fixture"}).json()["data"]["employee_id"]
    created = client.post(f"/api/manager/employees/{employee}/{path}", headers=headers, json=body)
    assert created.status_code == 201, created.text
    binding = created.json()["data"]["binding_id"]
    wrong = f"/api/manager/employees/{uuid.uuid4()}/{path}/{binding}"
    assert client.get(wrong, headers=headers).status_code == 404
    assert client.request(mutation, wrong + ("/activate" if mutation == "POST" else ""), headers=headers, json={}).status_code == 404
    assert client.delete(wrong, headers=headers).status_code == 404
    own = f"/api/manager/employees/{employee}/{path}/{binding}"
    assert client.get(own, headers=headers).status_code == 200
    with router.session(ctx) as s:
        s.execute("UPDATE app_user SET roles = ARRAY['member'] WHERE id = %s", (ctx.user_id,))
    assert client.get(own, headers=headers).status_code == 403
    assert client.delete(own, headers=headers).status_code == 403


def test_ip_rp_configuration_does_not_disable_password_health_or_oauth(auth_app, monkeypatch):
    client, ctx, account, headers, _, oauth = auth_app
    monkeypatch.setenv("MANAGER_PUBLIC_ORIGIN", "https://127.0.0.1")
    assert client.get("/healthz").status_code == 200
    assert client.post("/api/auth/login", json={"tenant_id": ctx.tenant_id, "account": account, "password": "Fixture-Pass-1"}).status_code == 200
    result = client.post("/api/manager/passkeys/registration-options", headers=headers)
    assert result.status_code == 503 and result.json()["code"] == "auth_origin_unconfigured"
    oauth._origin = AuthOrigin.parse("https://127.0.0.1")
    result = client.post("/api/auth/oauth/authorize", json={"tenant_id": ctx.tenant_id, "provider": "fakeprov", "redirect_uri": "https://127.0.0.1/auth/oauth/callback"})
    assert result.status_code == 200
