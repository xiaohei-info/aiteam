"""AuthService tenant_id 前置校验（非集成：mock repo/keys，无 DB）。

口径（AITEAM-230 / GitHub aiteam#255）：login / owner_reset 入参 tenant_id 非 UUID 时，
应在触碰 DB 前抛出 ValidationProblem（422）。目的是把"密码落库但 _issue 炸 500 不可回滚"
这条路径的入口关死，落到 422 而非 500。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from shared.errors import NotFound, Unauthorized, ValidationProblem
from manager_service.auth_service import (
    AuthService,
    EnterpriseAmbiguous,
    LoginInput,
    OwnerResetInput,
    TenantSelectionRequired,
)
from shared.contracts.enums import AuthProvider, EnterpriseRole


def _svc():
    """构造不碰 DB 的 AuthService：repo / keys 全 mock。TenantKeyStore 构造也只存 DSN。"""
    keys = MagicMock()
    return AuthService(dsn="postgresql://fake", repo=MagicMock(), keys=keys)


@pytest.mark.parametrize(
    "tenant_id",
    [
        "not-a-uuid",
        "12345",
        "",
        "550e8400-e29b-41d4-a716-446655440000 ",  # trailing space
        "gggggggg-gggg-gggg-gggg-gggggggggggg",  # non-hex
    ],
)
def test_login_rejects_non_uuid_tenant_id_before_db(tenant_id):
    svc = _svc()
    with pytest.raises(ValidationProblem) as exc:
        svc.login(LoginInput(tenant_id=tenant_id, account="13800138000", password="Pw1!"))
    # 入口校验：find_identity / keys.signer 均未被调用（未触 DB）。
    svc._repo.find_identity.assert_not_called()
    svc._keys.signer.assert_not_called()
    assert "invalid tenant_id format" in str(exc.value.detail)


@pytest.mark.parametrize(
    "tenant_id",
    [
        "not-a-uuid",
        "12345",
        "",
    ],
)
def test_owner_reset_rejects_non_uuid_tenant_id_before_db(tenant_id):
    svc = _svc()
    with pytest.raises(ValidationProblem) as exc:
        svc.owner_reset(
            OwnerResetInput(
                tenant_id=tenant_id, account="13800138000",
                old_password="Pw1!", new_password="NewPw2!",
            )
        )
    # owner_reset 原子性修复关键：update_secret 必须在 tenant_id 校验之后；
    # 校验失败时 update_secret 绝不能被调用（不会写库）。
    svc._repo.find_identity.assert_not_called()
    svc._repo.update_secret.assert_not_called()
    assert "invalid tenant_id format" in str(exc.value.detail)


def test_login_accepts_valid_uuid_tenant_id():
    """合法 UUID 走到 DB 校验（find_identity 被叫到）；仅验证入口不误杀合法 tenant_id。"""
    svc = _svc()
    svc._repo.find_identity.return_value = None  # 走到 Unauthorized
    with pytest.raises(Exception) as exc:
        svc.login(LoginInput(
            tenant_id="550e8400-e29b-41d4-a716-446655440000",
            account="13800138000", password="Pw1!",
        ))
    assert isinstance(exc.value, Unauthorized)
    svc._repo.find_identity.assert_called_once()


def test_sync_owner_bootstrap_replaces_existing_owner_credential():
    """Operator 重置 bootstrap 时必须覆盖已有 owner，而不能静默吞掉冲突。"""
    svc = _svc()
    existing = MagicMock(user_id="owner-1", status="active")
    svc._repo.find_identity.return_value = existing

    user_id = svc.sync_owner_bootstrap(
        "550e8400-e29b-41d4-a716-446655440000",
        phone="13800138000",
        bootstrap_password="Boot-Pass-1",
    )

    assert user_id == "owner-1"
    svc._repo.update_secret.assert_called_once()
    args, kwargs = svc._repo.update_secret.call_args
    assert kwargs["provider"] == AuthProvider.PHONE
    assert kwargs["external_id"] == "13800138000"
    assert kwargs["must_reset"] is True
    assert args[0].roles == [EnterpriseRole.OWNER.value]


def test_login_requires_enterprise_or_tenant_id():
    svc = _svc()
    with pytest.raises(ValidationProblem, match="enterprise or tenant_id is required"):
        svc.login(LoginInput(account="13800138000", password="Pw1!"))
    svc._repo.find_identity.assert_not_called()


def test_login_resolves_enterprise_without_tenant_uuid():
    svc = _svc()
    tenant_id = "550e8400-e29b-41d4-a716-446655440000"
    svc.resolve_tenant = MagicMock(return_value=tenant_id)
    svc._repo.find_identity.return_value = None
    with pytest.raises(Unauthorized):
        svc.login(LoginInput(enterprise="acme", account="13800138000", password="Pw1!"))
    svc.resolve_tenant.assert_called_once_with("acme")
    ctx = svc._repo.find_identity.call_args[0][0]
    assert ctx.tenant_id == tenant_id


def test_owner_reset_resolves_enterprise_without_tenant_uuid():
    svc = _svc()
    tenant_id = "550e8400-e29b-41d4-a716-446655440000"
    svc.resolve_tenant = MagicMock(return_value=tenant_id)
    svc._repo.find_identity.return_value = None
    with pytest.raises(Unauthorized):
        svc.owner_reset(
            OwnerResetInput(
                enterprise="acme",
                account="13800138000",
                old_password="Pw1!",
                new_password="Fresh-Pass-2",
            )
        )
    svc.resolve_tenant.assert_called_once_with("acme")
    svc._repo.update_secret.assert_not_called()
    ctx = svc._repo.find_identity.call_args[0][0]
    assert ctx.tenant_id == tenant_id


def test_login_rejects_enterprise_tenant_mismatch():
    svc = _svc()
    svc.resolve_tenant = MagicMock(return_value="550e8400-e29b-41d4-a716-446655440000")
    with pytest.raises(ValidationProblem, match="enterprise does not match tenant_id"):
        svc.login(LoginInput(
            enterprise="acme",
            tenant_id="11111111-1111-4111-8111-111111111111",
            account="13800138000",
            password="Pw1!",
        ))
    svc._repo.find_identity.assert_not_called()


@patch("psycopg.connect")
def test_resolve_tenant_slug_collision_is_enterprise_ambiguous(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.side_effect = [[], [("t-1",), ("t-2",)]]
    mock_connect.return_value.__enter__.return_value = conn
    with pytest.raises(EnterpriseAmbiguous) as exc:
        _svc().resolve_tenant("dup-slug")
    assert exc.value.status == 409
    assert exc.value.code == "enterprise_ambiguous"


@patch("psycopg.connect")
def test_resolve_tenant_unknown_enterprise_is_not_found(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = []
    mock_connect.return_value.__enter__.return_value = conn
    with pytest.raises(NotFound):
        _svc().resolve_tenant("missing-co")


@patch("psycopg.connect")
def test_resolve_tenant_by_account_duplicate_is_tenant_selection_required(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [("t-1",), ("t-2",)]
    mock_connect.return_value.__enter__.return_value = conn
    with pytest.raises(TenantSelectionRequired) as exc:
        _svc().resolve_tenant_by_account("13800000000")
    assert exc.value.status == 409
    assert exc.value.code == "tenant_selection_required"
