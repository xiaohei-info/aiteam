"""OAuth state and principal regressions through the real service (no mocked state success)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from manager_service.auth_origin import AuthOrigin
from manager_service.oauth import OAuthProfile
from manager_service.oauth_service import OAuthService
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, Unauthorized, ValidationProblem

ORIGIN = AuthOrigin.parse("https://manager.example")
REDIRECT = ORIGIN.oauth_redirect_uri
CTX = TenantContext(tenant_id="t1", user_id="u1", roles=["member"])


class FakeProvider:
    def __init__(self, name="fakeprov"):
        self.name, self.exchanged = name, []

    def authorization_url(self, state, redirect_uri, **kw):
        return f"https://provider.example/auth?state={state}"

    def exchange(self, code, redirect_uri):
        self.exchanged.append(code)
        return {"access_token": "synthetic"}

    def fetch_profile(self, token_resp):
        return OAuthProfile(provider=self.name, provider_user_id="sub-1")


def service():
    provider = FakeProvider()
    repo, connections, audit = MagicMock(), MagicMock(), MagicMock()
    repo.find_user.return_value = SimpleNamespace(user_id="u1", status="active", roles=["member"])
    repo.find_oauth_identity.return_value = None
    connections.find.return_value = None
    issuer = MagicMock(return_value="issued")
    svc = OAuthService(providers={"fakeprov": provider, "other": FakeProvider("other")}, connections=connections,
                       auth_repo=repo, audit=audit, issuer=issuer, origin=ORIGIN)
    return svc, provider


def authorize(svc, *, intent="login", ctx=CTX):
    return svc.authorize(provider="fakeprov", tenant_id="t1", redirect_uri=REDIRECT, intent=intent, ctx=ctx)["state"]


def test_link_then_login_resolves_active_principal():
    svc, provider = service()
    state = authorize(svc, intent="link")
    assert svc.link(CTX, provider="fakeprov", code="code", redirect_uri=REDIRECT, user_id="u1", state=state)["linked"]
    svc._connections.link.assert_called_once()
    svc._connections.find.return_value = SimpleNamespace(user_id="u1")
    assert svc.callback(provider="fakeprov", code="login", state=authorize(svc)) == "issued"
    assert provider.exchanged == ["code", "login"]


@pytest.mark.parametrize("status", ["disabled", "archived"])
def test_disabled_oauth_login_and_link_do_not_issue(status):
    svc, provider = service()
    state = authorize(svc)
    svc._connections.find.return_value = SimpleNamespace(user_id="u1")
    svc._auth_repo.find_user.return_value.status = status
    with pytest.raises(Forbidden):
        svc.callback(provider="fakeprov", code="code", state=state)
    with pytest.raises(Forbidden):
        authorize(svc, intent="link")
    svc._issuer.assert_not_called()
    svc._connections.upsert.assert_not_called()


@pytest.mark.parametrize("attack", ["login-as-link", "other-user", "other-tenant", "other-provider", "redirect"])
def test_state_scope_attacks_are_rejected_before_exchange(attack):
    svc, provider = service()
    state = authorize(svc, intent="login" if attack == "login-as-link" else "link")
    ctx = CTX.model_copy(update={"user_id": "u2"}) if attack == "other-user" else CTX
    if attack == "other-tenant":
        ctx = CTX.model_copy(update={"tenant_id": "t2"})
    with pytest.raises(ValidationProblem):
        svc.link(ctx, provider="other" if attack == "other-provider" else "fakeprov", code="code", state=state,
                 redirect_uri="https://evil.example/cb" if attack == "redirect" else REDIRECT, user_id=ctx.user_id)
    assert provider.exchanged == []


def test_link_state_cannot_login_and_state_cannot_replay():
    svc, provider = service()
    state = authorize(svc, intent="link")
    for _ in range(2):
        with pytest.raises(ValidationProblem):
            svc.callback(provider="fakeprov", code="code", state=state)
    assert provider.exchanged == []


def test_expired_state_rejected(monkeypatch):
    import manager_service.oauth as oauth
    svc, provider = service()
    state = authorize(svc)
    now = oauth.time.time()
    monkeypatch.setattr(oauth.time, "time", lambda: now+601)
    with pytest.raises(ValidationProblem):
        svc.callback(provider="fakeprov", code="code", state=state)
    assert provider.exchanged == []


def test_authorize_requires_trusted_redirect_and_authenticated_link():
    svc, _ = service()
    with pytest.raises(ValidationProblem):
        svc.authorize(provider="fakeprov", tenant_id="t1", redirect_uri="https://evil.example/cb")
    with pytest.raises(Unauthorized):
        authorize(svc, intent="link", ctx=None)


def test_identity_only_oauth_mapping_checks_status():
    svc, _ = service()
    svc._auth_repo.find_oauth_identity.return_value = SimpleNamespace(user_id="u1", status="disabled", roles=["owner"])
    with pytest.raises(Forbidden):
        svc.callback(provider="fakeprov", code="code", state=authorize(svc))
    svc._issuer.assert_not_called()
