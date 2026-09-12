"""存储持久化契约回归测试（issue AITEAM-330）。

接口契约（reset 场景下「新仓储实例」与「老实例」读到的数据一致）在内存层验证：
新建的仓储对之前写入完全无感知，等价于「进程重启 → 老数据丢失」，这正是此 Issue
要根治的 bug。

PostgreSQL 持久化端的「新 PgXxxRepository 实例从库读到老数据」属于集成测试域，需真实
PostgreSQL 后端，标记为 ``integration``（``-m 'not integration'`` 自动跳过），并复用
与 ``test_repository_pg.py`` 相同的环境变量约定。
"""

import os
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.summary import UsageSummary

# Use the independent Operation database; OPER_TEST_* aliases remain for
# isolated runs, and Manager DB URLs are never selected as a fallback.
ADMIN_DB_URL = os.getenv("OPERATION_ADMIN_DB_URL") or os.getenv("OPER_TEST_ADMIN_DB_URL")
APP_DB_URL = os.getenv("OPERATION_DB_URL") or os.getenv("OPER_TEST_DB_URL")
APP_RW_PASSWORD = os.getenv("OPER_TEST_APP_RW_PASSWORD") or os.getenv("APP_RW_PASSWORD", "test_password")
_PERSIST_E = "30000000-0000-4000-8000-000000000001"
_PERSIST_E2 = "30000000-0000-4000-8000-000000000002"
_PERSIST_E3 = "30000000-0000-4000-8000-000000000003"
_PERSIST_T = "40000000-0000-4000-8000-000000000001"

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def pg_setup():
    if not ADMIN_DB_URL or not APP_DB_URL:
        pytest.skip("integration test requires OPERATION_ADMIN_DB_URL/OPERATION_DB_URL (or OPER_TEST_* aliases)")
    from operation_service.repository import apply_migrations, PgEnterpriseRepository
    from operation_service.admin_repository import PgAdminRepository
    from operation_service.rollup_repository import PgRollupRepository
    from operation_service.catalog_repository import PgCatalogRepository
    from operation_service.solution_repository import PgSolutionRepository

    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)
    # Bootstrap the shared enterprise_account row admin-side methods depend on.
    PgEnterpriseRepository(APP_DB_URL).create(
        __import__("operation_service.repository", fromlist=["EnterpriseAccount"]).EnterpriseAccount(
            enterprise_id=_PERSIST_E, tenant_id=_PERSIST_T,
            enterprise_name="Persist", enterprise_code=None,
            owner_phone="13800000001", owner_bootstrap_hash="h",
        )
    )
    return {
        "admin": PgAdminRepository(APP_DB_URL),
        "rollup": PgRollupRepository(APP_DB_URL),
        "catalog": PgCatalogRepository(APP_DB_URL),
        "solution": PgSolutionRepository(APP_DB_URL),
    }


def _fresh(dsn, cls):
    return cls(dsn)


class TestFreshAdminSurvives:
    def test_recharge_survives_new_repo(self, pg_setup):
        repo = pg_setup["admin"]
        repo.add_recharge(_PERSIST_E, Decimal("50"))
        repo.add_recharge(_PERSIST_E, Decimal("25.5"))
        # New repo instance simulates a restart.
        assert _fresh(APP_DB_URL, type(repo)).total_recharged_all() == Decimal("75.5")

    def test_lifecycle_survives_new_repo(self, pg_setup):
        repo = pg_setup["admin"]
        repo.set_operation_status(_PERSIST_E, "suspended", reason="r")
        assert _fresh(APP_DB_URL, type(repo)).get_state(_PERSIST_E).operation_status == "suspended"

    def test_audit_survives_new_repo(self, pg_setup):
        repo = pg_setup["admin"]
        repo.record_audit(_PERSIST_E, "test_action", "detail")
        assert len(_fresh(APP_DB_URL, type(repo)).list_audits(_PERSIST_E)) == 1


class TestFreshRollupSurvives:
    def test_summary_survives_new_repo(self, pg_setup):
        repo = pg_setup["rollup"]
        s = UsageSummary(
            summary_id="persist-s1", tenant_id=_PERSIST_T,
            window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            window_end=datetime(2026, 1, 2, tzinfo=timezone.utc),
            run_count=3, token_total=300, cost_total=Decimal("4.5"),
        )
        repo.apply_summary(_PERSIST_E, _PERSIST_T, s)
        fresh = _fresh(APP_DB_URL, type(repo))
        assert fresh.get(_PERSIST_E).run_count == 3
        assert fresh.summaries_for(_PERSIST_E)[0].summary_id == "persist-s1"

    def test_idempotent_apply_in_persistence(self, pg_setup):
        repo = pg_setup["rollup"]
        s = UsageSummary(
            summary_id="persist-s2", tenant_id=_PERSIST_T,
            window_start=datetime(2026, 2, 1, tzinfo=timezone.utc),
            window_end=datetime(2026, 2, 2, tzinfo=timezone.utc),
            run_count=10, token_total=1000, cost_total=Decimal("1"), pricing_status="known",
        )
        repo.apply_summary(_PERSIST_E, _PERSIST_T, s)
        repo.apply_summary(_PERSIST_E, _PERSIST_T, s)  # duplicate should be idempotent
        assert _fresh(APP_DB_URL, type(repo)).get(_PERSIST_E).summary_count == 2

    def test_same_summary_id_is_scoped_to_enterprise(self, pg_setup):
        repo = pg_setup["rollup"]
        first = UsageSummary(
            summary_id="persist-shared-id", tenant_id=_PERSIST_T,
            window_start=datetime(2026, 3, 1, tzinfo=timezone.utc),
            window_end=datetime(2026, 3, 2, tzinfo=timezone.utc),
            run_count=1, token_total=10, cost_total=Decimal("0.1"), pricing_status="known",
        )
        second = first.model_copy(update={"tenant_id": "40000000-0000-4000-8000-000000000002", "token_total": 20})
        repo.apply_summary(_PERSIST_E2, _PERSIST_T, first)
        repo.apply_summary(_PERSIST_E3, second.tenant_id, second)
        fresh = _fresh(APP_DB_URL, type(repo))
        assert fresh.get(_PERSIST_E2).token_total == 10
        assert fresh.get(_PERSIST_E3).token_total == 20


class TestFreshCatalogSurvives:
    def test_template_survives_new_repo(self, pg_setup):
        repo = pg_setup["catalog"]
        from operation_service.catalog_repository import CatalogEntry
        entry = CatalogEntry(
            catalog_type=CatalogType.SOLUTION_TEMPLATE, template_id="persist-c1",
            version="1", display_name="Solution", status=CatalogStatus.DRAFT,
        )
        repo.create(entry)
        assert _fresh(APP_DB_URL, type(repo)).get(CatalogType.SOLUTION_TEMPLATE, "persist-c1").display_name == "Solution"


class TestFreshSolutionSurvives:
    def test_stats_survives_new_repo(self, pg_setup):
        repo = pg_setup["solution"]
        repo.record_apply(solution_id="persist-sol-1", enterprise_id=_PERSIST_E)
        repo.record_apply(solution_id="persist-sol-1", enterprise_id=_PERSIST_E)  # idempotent
        assert _fresh(APP_DB_URL, type(repo)).get_stats("persist-sol-1") == {
            "apply_count": 1, "active_enterprises": 1,
        }
