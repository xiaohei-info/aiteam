"""AdminService 单元测试（S01/S03/S04）。

覆盖：企业操作（充值/封禁/解封/通知/配额）、统计聚合、财务总览/报表、
方案统计、系统健康、未知企业 404、充值金额校验、操作审计轨迹。
"""

from decimal import Decimal

import pytest

from operation_service.admin_repository import AdminRepository
from operation_service.admin_service import AdminService
from operation_service.catalog_repository import CatalogEntry, CatalogRepository
from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.schemas import ProvisionEnterpriseRequest
from operation_service.service import ProvisioningService
from shared.contracts.enums import CatalogType
from shared.errors import NotFound


class FakeManagerGateway(ManagerGateway):
    def provision_tenant(self, req, *, idempotency_key): pass
    def sync_owner_bootstrap(self, req, *, idempotency_key): pass


@pytest.fixture
def admin_repo():
    return AdminRepository()


@pytest.fixture
def enterprise_repo():
    return InMemoryEnterpriseRepository()


@pytest.fixture
def catalog_repo():
    return CatalogRepository()


@pytest.fixture
def rollup_repo():
    return CrossEnterpriseRollupRepository()


@pytest.fixture
def service(admin_repo, enterprise_repo, catalog_repo, rollup_repo):
    return AdminService(admin_repo, enterprise_repo, catalog_repo, rollup_repo)


def _provision(enterprise_repo: InMemoryEnterpriseRepository, name: str = "Acme") -> str:
    """开通企业并返回 enterprise_id。"""
    gateway = FakeManagerGateway()
    svc = ProvisioningService(enterprise_repo, gateway)
    result = svc.provision_enterprise(ProvisionEnterpriseRequest(
        enterprise_name=name, owner_phone="13800000000"
    ))
    return result.enterprise_id


# ---- 企业操作 ----

def test_recharge_updates_total_and_creates_record(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "Acme")
    service.execute_action(eid, "recharge", Decimal("100.00"), None)
    state = admin_repo.get_state(eid)
    assert state.total_recharged == Decimal("100.00")
    records = admin_repo.list_recharges(enterprise_id=eid)
    assert len(records) == 1
    assert records[0].amount == Decimal("100.00")


def test_recharge_requires_positive_amount(service, enterprise_repo):
    eid = _provision(enterprise_repo, "Beta")
    with pytest.raises(Exception) as exc:
        service.execute_action(eid, "recharge", Decimal("0"), None)
    msg = str(exc.value).lower()
    assert "amount" in msg or "positive" in msg


def test_recharge_negative_rejected(service, enterprise_repo):
    eid = _provision(enterprise_repo, "Neg")
    with pytest.raises(Exception):
        service.execute_action(eid, "recharge", Decimal("-10"), None)


def test_ban_sets_banned_status(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "Gamma")
    service.execute_action(eid, "ban", None, None)
    state = admin_repo.get_state(eid)
    assert state.status == "banned"


def test_unban_restores_normal(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "Delta")
    service.execute_action(eid, "ban", None, None)
    service.execute_action(eid, "unban", None, None)
    state = admin_repo.get_state(eid)
    assert state.status == "normal"


def test_notify_records_audit_without_state_change(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "Epsilon")
    service.execute_action(eid, "notify", None, "hello")
    audits = admin_repo.list_audits(enterprise_id=eid)
    assert len(audits) == 1
    assert audits[0].action == "notify"
    assert "hello" in audits[0].detail


def test_adjust_quota_records_quota(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "Zeta")
    service.execute_action(eid, "adjust_quota", Decimal("5000"), None)
    state = admin_repo.get_state(eid)
    assert state.quotas == {"quota": "5000"}


def test_action_on_unknown_enterprise_404(service):
    with pytest.raises(NotFound):
        service.execute_action("ghost-enterprise-id", "ban", None, None)


# ---- 统计 ----

def test_stats_aggregation(service, enterprise_repo):
    eid_a = _provision(enterprise_repo, "A")
    eid_b = _provision(enterprise_repo, "B")
    service.execute_action(eid_a, "recharge", Decimal("100"), None)
    service.execute_action(eid_b, "recharge", Decimal("200"), None)
    stats = service.get_stats()
    assert stats["total_enterprises"] == 2
    assert stats["total_recharged"] == Decimal("300")


def test_stats_empty_when_no_enterprises(service):
    stats = service.get_stats()
    assert stats["total_enterprises"] == 0
    assert stats["total_recharged"] == Decimal("0")


# ---- 企业列表/详情/导出 ----

def test_list_enterprises_returns_real_data(service, enterprise_repo):
    eid = _provision(enterprise_repo, "ListCo")
    detail = service.get_enterprise_detail(eid)
    assert detail["org_id"] == eid
    assert detail["enterprise_name"] == "ListCo"
    assert detail["status"] == "normal"
    assert detail["total_recharged"] == Decimal("0")


def test_detail_unknown_enterprise_404(service):
    with pytest.raises(NotFound):
        service.get_enterprise_detail("does-not-exist")


def test_export_returns_rows(service, enterprise_repo):
    eid = _provision(enterprise_repo, "ExportCo")
    service.get_enterprise_detail(eid)
    result = service.export_enterprises()
    assert result["total"] == 1
    assert len(result["rows"]) == 1
    assert result["rows"][0]["enterprise_name"] == "ExportCo"


# ---- 财务 ----

def test_finance_overview_aggregates(service, enterprise_repo):
    eid = _provision(enterprise_repo, "FinCo")
    service.execute_action(eid, "recharge", Decimal("500"), None)
    overview = service.get_finance_overview("month")
    assert overview["period"] == "month"
    assert overview["total_recharged"] == Decimal("500")
    assert overview["top5_consumers"][0]["total_recharged"] == "500"


def test_finance_reports_has_details(service, enterprise_repo):
    eid = _provision(enterprise_repo, "FinCo2")
    service.execute_action(eid, "recharge", Decimal("300"), None)
    reports = service.get_finance_reports("all")
    assert len(reports["recharge_details"]) == 1
    assert reports["recharge_details"][0]["amount"] == "300"


def test_finance_empty_returns_zeroed(service):
    overview = service.get_finance_overview("all")
    assert overview["total_recharged"] == Decimal("0")
    assert overview["profit_margin"] == 0.0


# ---- 行业方案统计 ----

def test_solution_stats_from_catalog(service, catalog_repo):
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-a", version="1", display_name="Marketing",
    ))
    stats = service.get_solution_stats()
    assert len(stats) >= 1
    assert any(s["solution_id"] == "sol-a" for s in stats)


# ---- 系统健康 ----

def test_system_health_returns_status(service):
    health = service.get_system_health()
    assert health["status"] in ("healthy", "degraded")
    assert "timestamp" in health
    assert health["services"]["operation"] == "up"
