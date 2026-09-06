"""passkey_service / oauth_service unit tests (non-integration; FakeRouter + monkeypatched ceremony/provider)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from manager_service.passkey_service import PasskeyService
from shared.contracts.enums import AuthProvider
from shared.errors import Unauthorized

from ._fake_router import FakeCursor, FakeRouter, ctx


def _svc(roles=None):
    roles = roles or ["member"]
    router = FakeRouter()
    auth_repo = MagicMock()
    auth_repo.find_identity.return_value = MagicMock(user_id="u-1", roles=roles, status="active", secret="x", must_reset=False, password_changed_at=None)
    auth_repo.find_user.return_value = MagicMock(user_id="u-1", roles=roles, status="active")
    issuer = MagicMock(return_value="ISSUED_TOKEN")
    from manager_service.passkey_store import PasskeyStore
    from manager_service.login_audit import LoginAuditRepository
    return PasskeyService(auth_repo=auth_repo, store=PasskeyStore(router),
                          audit=LoginAuditRepository(router), issuer=issuer,
                          origin=__import__("manager_service.auth_origin", fromlist=["AuthOrigin"]).AuthOrigin.parse("https://manager.example")), auth_repo, router


def test_finish_login_unknown_credential_records_failure_and_raises(monkeypatch):
    svc, auth_repo, router = _svc()
    import manager_service.passkey_ceremony as cer
    monkeypatch.setattr(cer, "finish_login", lambda *a, **k: {"sign_count": 1})
    cred = MagicMock(tenant_id="t", user_id="u-1", public_key_pem="PEM", sign_count=0)
    svc._store.find_by_credential = lambda c, cid: None
    with pytest.raises(Unauthorized):
        svc.finish_login("t", {"tenant_id": "t", "id": "cred-x"})
    assert "INSERT INTO login_attempt" in router.last_sql
    params = router.executed[-1][1]
    assert params[5] is False  # success=False


def test_finish_login_success_path_issues_token(monkeypatch):
    svc, auth_repo, router = _svc(roles=["owner"])
    import manager_service.passkey_ceremony as cer
    monkeypatch.setattr(cer, "finish_login", lambda *a, **k: {"sign_count": 5})
    cred = MagicMock(tenant_id="t", user_id="u-1", public_key_pem="PEM", sign_count=0)
    svc._store.find_by_credential = lambda c, cid: cred
    svc._store.update_usage = lambda *a, **k: None
    out = svc.finish_login("t", {"tenant_id": "t", "id": "cred-x", "rawId": "", "response": {}})
    assert out == "ISSUED_TOKEN"
    # success audit recorded
    params = router.executed[-1][1]
    assert params[5] is True
