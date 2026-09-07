"""Online principal status is independent of offline JWT signature validity."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from manager_service.auth_service import AuthService, LoginInput, OwnerResetInput
from manager_service.repository import IdentityRow, TenantAuthRepository
from manager_service.security import hash_password
from shared.errors import Forbidden
from ._fake_router import FakeRouter, FakeCursor, ctx

TENANT = "550e8400-e29b-41d4-a716-446655440000"


def test_find_user_selects_exact_identity_shape():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("identity", "user", "hash", False, None, ["member"], "disabled")))
    row = TenantAuthRepository(router).find_user(ctx(), user_id="user")
    assert "ai.password_changed_at" in router.last_sql
    assert "u.status" in router.last_sql
    assert row.roles == ["member"] and row.status == "disabled"


@pytest.mark.parametrize("action", ["login", "reset", "issue"])
def test_disabled_principal_cannot_login_reset_or_issue(action):
    repo = MagicMock()
    identity = SimpleNamespace(identity_id="i", user_id="u", secret=hash_password("Test-Pass-1"),
                               must_reset=True, roles=["owner"], password_changed_at=None, status="disabled")
    repo.find_identity.return_value = repo.find_user.return_value = identity
    keys = MagicMock()
    keys.signer.return_value.sign.return_value = "synthetic-token"
    service = AuthService(dsn="unused", repo=repo, keys=keys)
    with pytest.raises(Forbidden) as exc:
        if action == "login":
            service.login(LoginInput(tenant_id=TENANT, account="a", password="Test-Pass-1"))
        elif action == "reset":
            service.owner_reset(OwnerResetInput(tenant_id=TENANT, account="a", old_password="Test-Pass-1", new_password="New-Pass-2"))
        else:
            service.issue(TENANT, "u", ["owner"])
    assert exc.value.code == "principal_inactive"
    repo.update_secret.assert_not_called()
    keys.signer.assert_not_called()


@pytest.mark.parametrize("roles", [["member"], ["owner"], ["enterprise_admin"]])
def test_disabled_snapshot_and_pull_rejected_even_with_grants(roles):
    from dataclasses import replace
    from shared.contracts.crosstier import AuthorizedConfigPullRequest
    from shared.contracts.tenancy import TenantContext
    from manager_service.authorized_config_service import AuthorizedConfigService
    from .test_snapshot import _services, _full_body
    config, grants, members, snapshot = _services()
    owner = TenantContext(tenant_id="t-a", user_id="u-1", roles=["owner"])
    employee = config.create(owner, _full_body(), employee_slug="active-test")
    members.set_member("t-a", "disabled")
    members._store["t-a"]["disabled"] = replace(members._store["t-a"]["disabled"], status="disabled")
    grants.set_grant("t-a", employee.employee_id, member_ids=["disabled"])
    principal = owner.model_copy(update={"user_id": "disabled", "roles": roles})
    with pytest.raises(Forbidden, match="not active"):
        snapshot.generate(principal, member_id="disabled", employee_id=employee.employee_id)
    pull = AuthorizedConfigService(config_service=config, grant_service=grants, member_service=members)
    with pytest.raises(Forbidden, match="not active"):
        pull.pull(principal, AuthorizedConfigPullRequest(tenant_id="t-a", member_id="disabled"))


def test_registered_manager_routes_use_current_status_roles_and_keep_authorized_snapshot():
    from fastapi import APIRouter
    from fastapi.testclient import TestClient
    from shared.app_factory import create_app
    from shared.config import Settings
    from manager_service.active_principal import ActivePrincipalVerifier
    from manager_service.routes_employee import build_employee_router
    from manager_service.routes_settings import build_settings_router
    from manager_service.routes_snapshot import build_snapshot_router
    from manager_service.settings_service import SettingsService
    from ._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
    from .test_snapshot import _services, _full_body, _ctx

    verifier, signer = make_inmem_verifier_and_signer()
    principal = SimpleNamespace(user_id="u-1", roles=["member"], status="active")
    repo = MagicMock()
    repo.find_user.return_value = principal
    online = ActivePrincipalVerifier(verifier, repo)
    config, grants, members, snapshot = _services()
    owner = _ctx("t-a", roles=["owner"])
    employee = config.create(owner, _full_body(), employee_slug="protected")
    grants.set_grant("t-a", employee.employee_id, member_ids=["u-1"])
    app = create_app(Settings(tier="manager", service_name="fixture", db_url="unused"), APIRouter())
    settings_repo = MagicMock()
    app.state._settings_service = SettingsService(settings_repo)
    app.state._employee_config_service = config
    app.state._snapshot_service = snapshot
    for router in (build_employee_router(online), build_settings_router(online), build_snapshot_router(online)):
        app.include_router(router)
    client = TestClient(app)
    # Signed owner claim is stale: real account is a member and must not inherit it online.
    token = sign_inmem_token(signer, "t-a", ["owner"], user_id="u-1")
    headers = {"Authorization": "Bearer " + token}
    assert client.patch("/api/manager/settings", headers=headers, json={"enterprise_name": "Denied"}).status_code == 403
    settings_repo.upsert_settings.assert_not_called()
    assert client.get(f"/api/manager/employees/{employee.employee_id}", headers=headers).status_code == 403
    body = {"tenant_id": "t-a", "employee_id": employee.employee_id, "member_id": "u-1"}
    response = client.post("/api/manager/snapshots", headers=headers, json=body)
    assert response.status_code == 200, response.text
    grants._store.clear()
    assert client.post("/api/manager/snapshots", headers=headers, json=body).status_code == 403
    principal.roles = ["enterprise_admin"]
    assert client.get(f"/api/manager/employees/{employee.employee_id}", headers=headers).status_code == 200
    principal.status = "disabled"
    assert client.post("/api/manager/snapshots", headers=headers, json=body).json()["code"] == "principal_inactive"
    # The offline signature verifier has no DB/status lookup; expiry semantics are unchanged.
    assert verifier.verify(token).user_id == "u-1"


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/prompts", None), ("GET", "/prompts/history", None),
    ("POST", "/prompts", {"system_prompt": "fixture"}), ("PUT", "/prompts", {"system_prompt": "fixture"}),
    ("DELETE", "/prompts", None), ("POST", "/prompts/rollback", {"target_version_no": 1}),
])
def test_public_prompt_configuration_gate_precedes_database(method, path, body):
    from fastapi import APIRouter
    from fastapi.testclient import TestClient
    from shared.app_factory import create_app
    from shared.config import Settings
    from manager_service.routes_employee_prompt import build_employee_prompt_router
    from ._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(Settings(tier="manager", service_name="fixture", db_url=None), APIRouter())
    app.include_router(build_employee_prompt_router(verifier))
    client = TestClient(app)
    for role, status in [("member", 403), ("finance_admin", 403), ("owner", 503)]:
        headers = {"Authorization": "Bearer " + sign_inmem_token(signer, "t1", [role], user_id="u1")}
        response = client.request(method, "/api/manager/employees/e1" + path, headers=headers, json=body)
        assert response.status_code == status, response.text
