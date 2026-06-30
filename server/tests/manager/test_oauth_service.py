"""oauth_service unit tests (non-integration; FakeRouter + fake provider)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from manager_service.oauth_service import OAuthService
from shared.errors import Unauthorized, ValidationProblem

from ._fake_router import FakeCursor, FakeRouter, ctx


class FakeProvider:
    name = "fakeprov"

    def __init__(self):
        self.exchanged = []

    def authorization_url(self, state, redirect_uri, **kw):
        return f"https://fake/auth?state={state}&r={redirect_uri}"

    def exchange(self, code, redirect_uri):
        self.exchanged.append(code)
        return {"access_token": "tok"}

    def fetch_profile(self, token_resp):
        from manager_service.oauth import OAuthProfile
        return OAuthProfile(provider="fakeprov", provider_user_id="fake-sub-1", email="a@b.com")


def _svc(state_store=None):
    router = FakeRouter()
    # queue a FakeCursor for oauth_connection.upsert RETURNING id (used by _resolve happy path)
    router.queue(FakeCursor(fetchone=("conn-id",)))
    prov = FakeProvider()
    auth_repo = MagicMock()
    auth_repo.find_user.return_value = MagicMock(user_id="u-1", roles=["member"])
    auth_repo.find_oauth_identity.return_value = None
    issuer = MagicMock(return_value="ISSUED_TOKEN")
    from manager_service.oauth import OAuthConnectionStore
    from manager_service.login_audit import LoginAuditRepository
    svc = OAuthService(
        providers={"fakeprov": prov},
        connections=OAuthConnectionStore(router),
        auth_repo=auth_repo,
        audit=LoginAuditRepository(router),
        issuer=issuer,
    )
    svc._connections.find = lambda c, external_id: None
    return svc, prov, router, auth_repo


import manager_service.oauth as oauth_mod


def test_authorize_returns_signed_state_and_url(monkeypatch):
    svc, prov, router, _ = _svc()
    res = svc.authorize(provider="fakeprov", tenant_id="t1", redirect_uri="https://x/cb")
    assert res["provider"] == "fakeprov"
    assert res["authorization_url"].startswith("https://fake/auth")
    assert res["state"]


def test_authorize_unknown_provider_raises_422():
    svc, *_ = _svc()
    with pytest.raises(ValidationProblem):
        svc.authorize(provider="totally-unknown", tenant_id="t1", redirect_uri="https://x/cb")


def test_callback_invalid_state_raises(monkeypatch):
    svc, *_ = _svc()
    with pytest.raises(ValidationProblem):
        svc.callback(provider="fakeprov", code="c", state="garbage")


def test_callback_happy_path_issues_token(monkeypatch):
    svc, prov, router, auth_repo = _svc()
    # connections.find returns None inside _resolve -> falls through to find_oauth_identity
    auth_repo.find_oauth_identity.return_value = MagicMock(
        user_id="u-1", roles=["member"], secret=None, must_reset=False,
    )
    auth_repo.find_user.side_effect = [None, MagicMock(user_id="u-1", roles=["member"])]
    # shadow _consume_state to return a valid payload
    import manager_service.oauth_service as osvc
    monkeypatch.setattr(osvc, "_consume_state", lambda s: {"t": "t1", "r": "https://x/cb", "n": ""})
    out = svc.callback(provider="fakeprov", code="good", state="whatever")
    assert out == "ISSUED_TOKEN"
    assert prov.exchanged == ["good"]
    # success audit recorded -> INSERT login_attempt in oauth_connection writes + login_attempt
    assert any("INSERT INTO oauth_connection" in sql for sql, _ in router.executed)
    last = router.executed[-1][1]
    assert "INSERT INTO login_attempt" in router.executed[-1][0]
    assert last[5] is True  # success=True
