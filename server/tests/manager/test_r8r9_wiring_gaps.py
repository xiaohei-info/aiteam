"""R8/R9 装配层单元测试：/me 的服务装配与企业代码读取、开通时写企业名、无租户 token 改密。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import psycopg
import pytest

from shared.contracts.auth import TokenClaims
from shared.errors import AppError, Unauthorized

from manager_service import routes_me, routes_tenant
from manager_service.auth_service import AuthService

TENANT = "11111111-1111-4111-8111-111111111111"


def _request(db_url, admin_db_url=None):
    state = SimpleNamespace(settings=SimpleNamespace(db_url=db_url, admin_db_url=admin_db_url))
    return SimpleNamespace(app=SimpleNamespace(state=state))


def test_me_service_requires_business_db():
    with pytest.raises(AppError) as exc:
        routes_me._service(_request(None))
    assert exc.value.status == 503 and exc.value.code == "manager_db_unconfigured"


def test_me_service_is_built_once_and_cached():
    request = _request("postgresql://fake/business", "postgresql://fake/admin")
    with patch.object(routes_me, "PgTenantRouter") as router:
        first = routes_me._service(request)
        second = routes_me._service(request)
    assert first is second
    router.assert_called_once_with("postgresql://fake/business")


def test_registry_code_is_none_without_admin_dsn():
    assert routes_me._registry_code_reader(None)(TENANT) is None


def test_registry_code_reads_enterprise_code():
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.execute.return_value.fetchone.return_value = ("acme",)
    with patch.object(psycopg, "connect", return_value=conn) as connect:
        assert routes_me._registry_code_reader("postgresql://fake/admin")(TENANT) == "acme"
    connect.assert_called_once_with("postgresql://fake/admin", autocommit=True)
    assert conn.execute.call_args.args[1] == (TENANT,)


@pytest.mark.parametrize("row", [None, (None,), ("",)])
def test_registry_code_missing_or_blank_is_none(row):
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.execute.return_value.fetchone.return_value = row
    with patch.object(psycopg, "connect", return_value=conn):
        assert routes_me._registry_code_reader("postgresql://fake/admin")(TENANT) is None


def test_registry_code_read_failure_does_not_break_the_page():
    with patch.object(psycopg, "connect", side_effect=psycopg.OperationalError("down")):
        assert routes_me._registry_code_reader("postgresql://fake/admin")(TENANT) is None


def test_seed_enterprise_name_writes_through_settings_repository():
    with patch("manager_service.settings_repository.SettingsRepository") as repo, patch("shared.db.PgTenantRouter") as router:
        routes_tenant.seed_enterprise_name("postgresql://fake/business", TENANT, "星河科技")
    router.assert_called_once_with("postgresql://fake/business")
    (ctx, name), _ = repo.return_value.ensure_enterprise_name.call_args
    assert name == "星河科技"
    assert ctx.tenant_id == TENANT and ctx.user_id == "system" and ctx.roles == ["owner"]


def test_change_password_rejects_token_without_tenant():
    svc = AuthService(dsn="x", repo=MagicMock(), keys=None, audit=MagicMock(), sessions=None)
    claims = TokenClaims(tenant_id=None, user_id="u-1", roles=["member"], exp=9999999999, jti="j")
    with pytest.raises(Unauthorized):
        svc.change_password(claims, old_password="a", new_password="b")
