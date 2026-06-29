"""契约：Wave0 共享 fixtures 在 fixtures/ **之外的 sibling 目录**亦可见。

回归 reviewer Blocker 2：fixtures 注册若只落在 `tests/integration/fixtures/conftest.py`，
sibling 目录拿不到 `tenant_scope` 等。本测试落在 sibling 目录 `_foundation_consumers/`，
若 fixtures 未在 `tests/integration/conftest.py` 注册，pytest 会报 `fixture not found`
（collection error），而非 skip——所以它是 sibling 可见性的硬证据。

非 DB fixtures（operator_admin/service_token_headers）确定性证明可见性（无需 PG，任何环境跑全）；
DB fixtures（tenant_scope/seeded_enterprise）的可见性同样被解析，仅在无 PG 时于 fixture 内部 skip。
"""

from __future__ import annotations

import pytest

from tests.integration.fixtures.identities import Identity


def test_non_db_foundation_fixtures_visible_in_sibling_dir(operator_admin, service_token_headers):
    """非 DB 共享 fixtures 在 sibling 目录可注入——确定性可见性证据（无需 PG）。"""
    assert isinstance(operator_admin, Identity)
    assert operator_admin.roles  # 平台管理员角色已签
    assert "X-Service-Token" in service_token_headers


@pytest.mark.integration
def test_db_foundation_fixtures_visible_in_sibling_dir(tenant_scope, seeded_enterprise, manager_owner):
    """DB 共享 fixtures（PG/seed/身份）在 sibling 目录可注入并联动（真 PG）。"""
    assert seeded_enterprise.tenant_id == tenant_scope.tenant_id
    assert manager_owner.tenant_id == tenant_scope.tenant_id
    with tenant_scope.session(["owner"]) as s:
        assert s.execute("SELECT count(*) FROM app_user").fetchone()[0] == 2
