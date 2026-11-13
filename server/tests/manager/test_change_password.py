"""R9：已登录成员自助设置新密码（AuthService.change_password）。"""

from __future__ import annotations

import pytest

from shared.contracts.auth import TokenClaims
from shared.errors import AppError

from manager_service.active_principal import require_active  # noqa: F401  (确保模块可导入)
from manager_service.auth_service import AuthService
from manager_service.repository import IdentityRow
from manager_service.security import hash_password, verify_password

TENANT = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
OLD = "Old-Passw0rd!"
NEW = "New-Passw0rd!"


class _Repo:
    def __init__(self, secret):
        self.row = IdentityRow(
            identity_id="i1", user_id=USER, secret=secret, must_reset=False,
            password_changed_at=None, roles=["member"], status="active",
        )
        self.updated = []

    def find_user(self, ctx, *, user_id):
        return self.row

    def update_secret_for_user(self, ctx, *, user_id, secret):
        self.updated.append((user_id, secret))


class _Sessions:
    def __init__(self):
        self.calls = []

    def revoke_user_except(self, ctx, *, keep_jti, reason):
        self.calls.append((keep_jti, reason))


class _Audit:
    def __init__(self, failures=0):
        self.failures = failures
        self.records = []

    def record(self, ctx, **kw):
        self.records.append(kw)
        if not kw["success"]:
            self.failures += 1

    def count_recent_failures(self, ctx, *, actor, detail, within_minutes):
        return self.failures


def _svc(secret: str | None = None, *, audit: _Audit | None | str = "default", failures: int = 0):
    repo = _Repo(hash_password(OLD) if secret is None else secret)
    sessions = _Sessions()
    audit_obj: _Audit | None = _Audit(failures) if audit == "default" else None if audit is None else audit  # type: ignore[assignment]
    svc = AuthService(dsn="x", repo=repo, keys=None, audit=audit_obj, sessions=sessions)
    return svc, repo, sessions, audit_obj


def _claims():
    return TokenClaims(tenant_id=TENANT, user_id=USER, roles=["member"], exp=9999999999, jti="jti-current")


def test_success_updates_hash_and_keeps_only_current_session():
    svc, repo, sessions, audit = _svc()
    svc.change_password(_claims(), old_password=OLD, new_password=NEW)
    assert len(repo.updated) == 1
    assert verify_password(NEW, repo.updated[0][1])
    assert sessions.calls == [("jti-current", "password_changed")]
    assert audit is not None and audit.records[-1]["success"] is True


def test_wrong_old_password_is_422_and_counts_as_failure():
    svc, repo, sessions, audit = _svc()
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password="nope", new_password=NEW)
    assert exc.value.status == 422 and exc.value.code == "old_password_incorrect"
    assert repo.updated == [] and sessions.calls == []
    assert audit is not None and audit.records[-1]["success"] is False


def test_same_password_is_422():
    svc, repo, *_ = _svc()
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password=OLD, new_password=OLD)
    assert exc.value.status == 422
    assert repo.updated == []


def test_new_password_must_meet_policy():
    svc, repo, *_ = _svc()
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password=OLD, new_password="short")
    assert exc.value.status == 422
    assert repo.updated == []


def test_five_wrong_attempts_lock_even_the_right_old_password():
    svc, repo, *_ = _svc(failures=5)
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password=OLD, new_password=NEW)
    assert exc.value.status == 429 and exc.value.code == "too_many_attempts"
    assert repo.updated == []


def test_four_failures_still_allowed():
    svc, repo, *_ = _svc(failures=4)
    svc.change_password(_claims(), old_password=OLD, new_password=NEW)
    assert len(repo.updated) == 1


def test_oauth_only_account_is_409():
    svc, repo, *_ = _svc(secret="")
    repo.row = IdentityRow(
        identity_id="i1", user_id=USER, secret=None, must_reset=False,
        password_changed_at=None, roles=["member"], status="active",
    )
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password=OLD, new_password=NEW)
    assert exc.value.status == 409 and exc.value.code == "password_not_set"


def test_rejected_when_audit_store_is_not_configured():
    svc, repo, *_ = _svc(audit=None)
    with pytest.raises(AppError) as exc:
        svc.change_password(_claims(), old_password=OLD, new_password=NEW)
    assert exc.value.status == 503
    assert repo.updated == []
