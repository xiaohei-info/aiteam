"""未填企业标识时的登录 / 首次改密企业匹配（PR #230 评审：密码通过后才返回企业名单）。

口径：按账号找到所有未归档身份 → 逐个企业校验密码 → 只保留密码通过的企业；
一个直接登录，多个优先 active，仍多个则 409 + meta.candidates（tenant_id + 真实企业名）。
账号不存在与密码错误返回完全相同的 401。旧「凭账号查企业」接口固定 410。
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from shared.db import PgTenantRouter
from shared.errors import Unauthorized
from shared.security import hash_password

from manager_service.auth_password_policy import PasswordResetRequired
from manager_service.auth_service import (
    AuthService,
    LoginInput,
    OwnerResetInput,
    TenantSelectionRequired,
)
from manager_service.keys import TenantKeyStore
from manager_service.repository import IdentityRow, TenantAuthRepository

T_A = "00000000-0000-4000-8000-00000000000a"
T_B = "00000000-0000-4000-8000-00000000000b"
T_C = "00000000-0000-4000-8000-00000000000c"


# ---------------------------------------------------------------------------
# 单元：不依赖 PG；_account_tenants / 企业状态 / 签发打桩
# ---------------------------------------------------------------------------


def _identity(tid: str, password: str, *, must_reset: bool = False) -> IdentityRow:
    return IdentityRow(
        identity_id=f"id-{tid}", user_id=f"user-{tid}", secret=hash_password(password),
        must_reset=must_reset, roles=["member"],
    )


def _svc(directory: dict[str, tuple[str, str]], passwords: dict[str, str], *, must_reset=False):
    """directory: tenant_id → (status, enterprise_name)；passwords: tenant_id → 该企业里的密码。"""
    repo = MagicMock()
    identities = {tid: _identity(tid, pw, must_reset=must_reset) for tid, pw in passwords.items()}
    repo.find_identity.side_effect = lambda ctx, **_: identities.get(ctx.tenant_id)
    svc = AuthService(dsn="postgresql://f/f", repo=repo, keys=MagicMock(), admin_dsn="postgresql://admin/a")
    svc._account_tenants = MagicMock(return_value=directory)
    svc.resolve_tenant = MagicMock(side_effect=AssertionError("must not resolve enterprise identifier"))
    svc._assert_tenant_active = MagicMock()
    svc._issue = MagicMock(side_effect=lambda tid, uid, roles: {"tenant_id": tid, "user_id": uid})
    return svc


def _login(svc, password, *, tenant_id=None, account="13800000000"):
    return svc.login(LoginInput(account=account, password=password, tenant_id=tenant_id))


def _problem(exc: Exception) -> tuple:
    return exc.status, exc.code, exc.detail, exc.meta


def test_unknown_account_and_wrong_password_return_identical_401():
    unknown = _svc({}, {})
    with pytest.raises(Unauthorized) as no_account:
        _login(unknown, "{{SECRET_kp6tyr0r}}")
    known = _svc({T_A: ("active", "甲企业")}, {T_A: "{{SECRET_cmcfj3hy}}"})
    with pytest.raises(Unauthorized) as wrong_pw:
        _login(known, "{{SECRET_kp6tyr0r}}")
    assert _problem(no_account.value) == _problem(wrong_pw.value) == (401, "unauthorized", "invalid credentials", None)


def test_single_password_match_logs_in_without_candidates():
    """账号在 A、B 都存在但只有 A 的密码对 → 直接登录 A，不返回候选。"""
    svc = _svc({T_A: ("active", "甲企业"), T_B: ("active", "乙企业")}, {T_A: "Right#1234", T_B: "Other#1234"})
    assert _login(svc, "Right#1234")["tenant_id"] == T_A


def test_candidates_only_list_enterprises_whose_password_matches():
    svc = _svc(
        {T_A: ("active", "甲企业"), T_B: ("active", "乙企业"), T_C: ("active", "丙企业")},
        {T_A: "Same#1234", T_B: "Same#1234", T_C: "Other#1234"},
    )
    with pytest.raises(TenantSelectionRequired) as exc:
        _login(svc, "Same#1234")
    assert exc.value.status == 409
    expected = sorted(
        [{"tenant_id": T_A, "enterprise_name": "甲企业"}, {"tenant_id": T_B, "enterprise_name": "乙企业"}],
        key=lambda c: (c["enterprise_name"], c["tenant_id"]),
    )
    assert exc.value.meta == {"candidates": expected}
    assert T_C not in {c["tenant_id"] for c in exc.value.meta["candidates"]}


def test_password_match_prefers_active_over_inactive():
    svc = _svc({T_A: ("suspended", "旧企业"), T_B: ("active", "新企业")}, {T_A: "Same#1234", T_B: "Same#1234"})
    assert _login(svc, "Same#1234")["tenant_id"] == T_B


def test_multi_enterprise_login_with_selected_tenant_id_skips_matching():
    """409 候选 → 带 tenant_id 重试：只在该企业校验，不再触发第二次企业匹配 / 标识解析。"""
    svc = _svc({T_A: ("active", "甲企业"), T_B: ("active", "乙企业")}, {T_A: "Same#1234", T_B: "Same#1234"})
    with pytest.raises(TenantSelectionRequired) as exc:
        _login(svc, "Same#1234")
    picked = exc.value.meta["candidates"][1]["tenant_id"]
    svc._account_tenants.reset_mock()
    assert _login(svc, "Same#1234", tenant_id=picked)["tenant_id"] == picked
    svc._account_tenants.assert_not_called()
    svc.resolve_tenant.assert_not_called()


def test_selected_tenant_id_with_wrong_password_is_same_401():
    svc = _svc({T_A: ("active", "甲企业")}, {T_A: "Right#1234"})
    with pytest.raises(Unauthorized) as exc:
        _login(svc, "Wrong#1234", tenant_id=T_A)
    assert _problem(exc.value) == (401, "unauthorized", "invalid credentials", None)


def test_reset_required_response_carries_tenant_id_and_owner_reset_works_without_enterprise():
    """首次登录：403 meta.tenant_id 指明企业；改密不带企业标识、只带 tenant_id 可走通。"""
    svc = _svc({T_A: ("active", "甲企业"), T_B: ("active", "乙企业")},
               {T_A: "Boot#12345", T_B: "Other#1234"}, must_reset=True)
    with pytest.raises(PasswordResetRequired) as exc:
        _login(svc, "Boot#12345")
    assert exc.value.meta == {"tenant_id": T_A}
    svc._account_tenants.reset_mock()
    result = svc.owner_reset(OwnerResetInput(
        account="13800000000", old_password="Boot#12345", new_password="NewPass#2026", tenant_id=T_A,
    ))
    assert result["tenant_id"] == T_A
    svc._account_tenants.assert_not_called()
    svc._repo.update_secret.assert_called_once()


def test_owner_reset_without_any_enterprise_matches_by_old_password():
    svc = _svc({T_A: ("active", "甲企业"), T_B: ("active", "乙企业")},
               {T_A: "Other#1234", T_B: "Boot#12345"}, must_reset=True)
    result = svc.owner_reset(OwnerResetInput(account="13800000000", old_password="Boot#12345",
                                             new_password="NewPass#2026"))
    assert result["tenant_id"] == T_B
    ctx = svc._repo.update_secret.call_args[0][0]
    assert ctx.tenant_id == T_B


def test_owner_reset_wrong_old_password_without_enterprise_is_same_401():
    svc = _svc({T_A: ("active", "甲企业")}, {T_A: "Boot#12345"}, must_reset=True)
    with pytest.raises(Unauthorized) as exc:
        svc.owner_reset(OwnerResetInput(account="13800000000", old_password="Nope#12345",
                                        new_password="NewPass#2026"))
    assert _problem(exc.value) == (401, "unauthorized", "invalid credentials", None)
    svc._repo.update_secret.assert_not_called()


@patch("psycopg.connect")
def test_account_directory_query_uses_enterprise_settings_name_and_skips_archived(mock_connect):
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [(T_A, "active", "贝拉乔")]
    mock_connect.return_value.__enter__.return_value = conn
    svc = AuthService(dsn="postgresql://f/f", repo=MagicMock(), keys=MagicMock(), admin_dsn="postgresql://admin/a")
    assert svc._account_tenants("13800000000") == {T_A: ("active", "贝拉乔")}
    sql, params = conn.execute.call_args[0]
    assert params == ("13800000000",)
    assert "LEFT JOIN enterprise_settings" in sql
    assert "COALESCE(NULLIF(es.enterprise_name, ''), tr.enterprise_slug)" in sql
    assert "archived_at IS NULL" in sql
    mock_connect.assert_called_once_with("postgresql://admin/a", autocommit=True)


@patch("psycopg.connect")
def test_enterprise_code_shared_with_deleted_tenant_prefers_active(mock_connect):
    """企业代码在 purge 前仍被已删除企业占用：按代码解析只认 active 那家，不报歧义。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [("t-deleted", "deleted"), ("t-live", "active")]
    mock_connect.return_value.__enter__.return_value = conn
    svc = AuthService(dsn="postgresql://f/f", repo=MagicMock(), keys=MagicMock(), admin_dsn="postgresql://admin/a")
    assert svc.resolve_tenant("ACME") == "t-live"


@pytest.mark.parametrize("statuses", [
    ["suspended", "banned"],
    ["banned", "closed"],
    ["closed", "deleted"],
])
@patch("psycopg.connect")
def test_enterprise_identifier_hitting_only_inactive_tenants_reports_no_active_enterprise(mock_connect, statuses):
    """同一标识命中多家且全都不可用：报「没有可登录的企业」，而不是让用户改填企业代码的 enterprise_ambiguous。"""
    conn = MagicMock()
    conn.execute.return_value.fetchall.return_value = [(f"t-{i}", s) for i, s in enumerate(statuses)]
    mock_connect.return_value.__enter__.return_value = conn
    svc = AuthService(dsn="postgresql://f/f", repo=MagicMock(), keys=MagicMock(), admin_dsn="postgresql://admin/a")
    with pytest.raises(Exception) as exc:
        svc.resolve_tenant("ACME")
    assert exc.value.code == "no_active_enterprise"
    assert exc.value.status == 403


# ---------------------------------------------------------------------------
# 真库：企业生命周期 × 登录企业匹配（缺陷记录 2026-11-25「登录企业解析缺陷」回归）
# ---------------------------------------------------------------------------

_BOOT = "Boot-Pass-2"


@pytest.fixture
def auth_svc(migrated_db: str, admin_url: str):
    return AuthService(
        dsn=migrated_db,
        repo=TenantAuthRepository(PgTenantRouter(migrated_db)),
        keys=TenantKeyStore(admin_url),
        admin_dsn=admin_url,
    )


def _new_phone():
    return f"1{uuid.uuid4().int % 10_000_000_000:010d}"


def _tenant_with_phone(auth_svc, admin_url, phone, *, slug=None, name=None, password=_BOOT):
    import psycopg

    tid = str(uuid.uuid4())
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (enterprise_slug, tenant_id) VALUES (%s, %s)",
            (slug or f"ent_{uuid.uuid4().hex[:8]}", tid),
        )
        if name is not None:
            conn.execute(
                "INSERT INTO enterprise_settings (tenant_id, enterprise_name) VALUES (%s, %s)", (tid, name),
            )
    auth_svc.provision_owner(tid, phone=phone, bootstrap_password=password)
    return tid


def _login_pg(auth_svc, phone, password, **kw):
    return auth_svc.login(LoginInput(account=phone, password=password, **kw))


@pytest.mark.integration
def test_pg_unknown_account_and_wrong_password_identical(auth_svc, admin_url):
    phone = _new_phone()
    _tenant_with_phone(auth_svc, admin_url, phone)
    with pytest.raises(Unauthorized) as wrong_pw:
        _login_pg(auth_svc, phone, "Wrong#12345")
    with pytest.raises(Unauthorized) as no_account:
        _login_pg(auth_svc, _new_phone(), "Wrong#12345")
    assert _problem(wrong_pw.value) == _problem(no_account.value)


@pytest.mark.integration
def test_pg_candidates_use_enterprise_name_and_fall_back_to_slug(auth_svc, admin_url):
    phone = _new_phone()
    slug_a, slug_b = f"a_{uuid.uuid4().hex[:8]}", f"b_{uuid.uuid4().hex[:8]}"
    tid_a = _tenant_with_phone(auth_svc, admin_url, phone, slug=slug_a, name="贝拉乔科技")
    tid_b = _tenant_with_phone(auth_svc, admin_url, phone, slug=slug_b, name="")
    _tenant_with_phone(auth_svc, admin_url, phone, password="Another#2026")  # 密码不同 → 不进候选
    with pytest.raises(TenantSelectionRequired) as exc:
        _login_pg(auth_svc, phone, _BOOT)
    by_tid = {c["tenant_id"]: c["enterprise_name"] for c in exc.value.meta["candidates"]}
    assert by_tid == {tid_a: "贝拉乔科技", tid_b: slug_b}
    with pytest.raises(PasswordResetRequired) as reset:
        _login_pg(auth_svc, phone, _BOOT, tenant_id=tid_a)
    assert reset.value.meta == {"tenant_id": tid_a}


@pytest.mark.integration
def test_pg_first_login_reset_without_enterprise(auth_svc, admin_url):
    phone = _new_phone()
    tid = _tenant_with_phone(auth_svc, admin_url, phone)
    with pytest.raises(PasswordResetRequired) as exc:
        _login_pg(auth_svc, phone, _BOOT)
    result = auth_svc.owner_reset(OwnerResetInput(
        account=phone, old_password=_BOOT, new_password="NewPass#2026", tenant_id=exc.value.meta["tenant_id"],
    ))
    assert result.claims.tenant_id == tid
    assert _login_pg(auth_svc, phone, "NewPass#2026").claims.tenant_id == tid


@pytest.mark.integration
@pytest.mark.parametrize("status", ["deleted", "closed"])
def test_pg_closed_or_deleted_tenant_drops_out_after_status_change(auth_svc, admin_url, status):
    """同号同密码跨 active + 注销/删除企业：状态下发后身份归档，只剩 active 企业（不再 409）。"""
    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    old = _tenant_with_phone(auth_svc, admin_url, phone)
    live = _tenant_with_phone(auth_svc, admin_url, phone)
    with pytest.raises(TenantSelectionRequired):
        _login_pg(auth_svc, phone, _BOOT)
    TenantStatusStore(admin_url).set_status(old, status, "test")
    with pytest.raises(PasswordResetRequired) as exc:
        _login_pg(auth_svc, phone, _BOOT)
    assert exc.value.meta == {"tenant_id": live}


@pytest.mark.integration
def test_pg_deleted_tenant_identity_archived_and_restore_unarchives(auth_svc, admin_url):
    import psycopg

    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    tid = _tenant_with_phone(auth_svc, admin_url, phone)
    store = TenantStatusStore(admin_url)
    store.set_status(tid, "deleted", "test")
    with psycopg.connect(admin_url, autocommit=True) as conn:
        archived = conn.execute(
            "SELECT count(*) FROM auth_identity WHERE tenant_id = %s AND archived_at IS NOT NULL", (tid,),
        ).fetchone()[0]
    assert archived >= 1
    with pytest.raises(Unauthorized):
        _login_pg(auth_svc, phone, _BOOT)
    store.set_status(tid, "active", None)
    with pytest.raises(PasswordResetRequired) as exc:
        _login_pg(auth_svc, phone, _BOOT)
    assert exc.value.meta == {"tenant_id": tid}


@pytest.mark.integration
def test_pg_suspended_tenant_is_not_archived_and_reports_status(auth_svc, admin_url):
    from manager_service.tenant_status import TenantStatusStore

    phone = _new_phone()
    tid = _tenant_with_phone(auth_svc, admin_url, phone)
    TenantStatusStore(admin_url).set_status(tid, "suspended", "test")
    with pytest.raises(Exception) as exc:
        _login_pg(auth_svc, phone, _BOOT)
    assert exc.value.code == "tenant_suspended"
