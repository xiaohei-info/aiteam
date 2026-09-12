"""AdminService 单元测试（S01/S03/S04）。

覆盖：企业操作（充值/封禁/解封/通知/配额）、统计聚合、财务总览/报表、
方案统计、系统健康、未知企业 404、充值金额校验、操作审计轨迹。
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from operation_service.admin_repository import AdminRepository
from operation_service.admin_service import AdminService
from operation_service.catalog_repository import CatalogEntry, CatalogRepository
from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import InMemoryEnterpriseRepository
from shared.contracts.crosstier import EnterpriseNotifyRequest
from shared.contracts.summary import UsageSummary
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.solution_repository import SolutionRepository
from operation_service.schemas import ProvisionEnterpriseRequest
from operation_service.service import ProvisioningService
from shared.contracts.enums import CatalogType
from shared.errors import NotFound


class FakeManagerGateway(ManagerGateway):
    def provision_tenant(self, req, *, idempotency_key): pass
    def sync_owner_bootstrap(self, req, *, idempotency_key): pass
    notifications: list = []
    def notify_enterprise(self, req, *, idempotency_key):
        self.notifications.append((req, idempotency_key))


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
def solution_repo():
    return SolutionRepository()


@pytest.fixture
def service(admin_repo, enterprise_repo, catalog_repo, rollup_repo, solution_repo):
    return AdminService(admin_repo, enterprise_repo, catalog_repo, rollup_repo, solution_repo)


def _provision(
    enterprise_repo: InMemoryEnterpriseRepository,
    name: str = "Acme",
    *,
    admin_repo: AdminRepository | None = None,
) -> str:
    """开通企业并返回 enterprise_id。传入 admin_repo 时验证开通即注册。"""
    gateway = FakeManagerGateway()
    svc = ProvisioningService(enterprise_repo, gateway, admin_repo=admin_repo)
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
    assert state.status == "active"


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
    q = admin_repo.get_quota(eid)
    assert q.token_quota_limit == 5000


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
    assert detail["status"] == "active"
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

def test_finance_overview_keeps_revenue_and_api_cost_separate(service, enterprise_repo):
    eid = _provision(enterprise_repo, "FinCo")
    service.execute_action(eid, "recharge", Decimal("500"), None)
    overview = service.get_finance_overview("month")
    assert overview["period"] == "month"
    assert overview["total_recharged"] == Decimal("500")
    assert overview["revenue_currency"] == "CNY"
    assert overview["cost_currency"] == "USD"
    assert overview["gross_profit"] is None
    assert overview["top5_consumers"] == []


def test_finance_overview_ranks_usage_cost_and_tracks_unknown_tokens(service, enterprise_repo, rollup_repo):
    eid = _provision(enterprise_repo, "UsageCo")
    start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    rollup_repo.apply_summary(eid, "tenant-1", UsageSummary(
        summary_id="known", tenant_id="tenant-1", employee_id="emp-1",
        window_start=start, window_end=start + timedelta(hours=1),
        run_count=1, token_total=100, cost_total=Decimal("0.000084"),
        pricing_version=1, pricing_status="known",
    ))
    rollup_repo.apply_summary(eid, "tenant-1", UsageSummary(
        summary_id="unknown", tenant_id="tenant-1", employee_id="emp-1",
        window_start=start, window_end=start + timedelta(hours=1),
        run_count=1, token_total=50, cost_total=Decimal("0"),
        pricing_status="unknown",
    ))
    overview = service.get_finance_overview("month")
    assert overview["total_tokens_billed"] == 150
    assert overview["total_api_cost"] == Decimal("0.000084")
    assert overview["unknown_pricing_tokens"] == 50
    assert overview["top5_consumers"][0]["cost_total"] == "0.000084"
    assert overview["top5_consumers"][0]["pricing_status"] == "partial"

    unknown_eid = _provision(enterprise_repo, "UnknownUsageCo")
    rollup_repo.apply_summary(unknown_eid, "tenant-1", UsageSummary(
        summary_id="unknown-only", tenant_id="tenant-1", employee_id="emp-1",
        window_start=start, window_end=start + timedelta(hours=1),
        run_count=1, token_total=25, cost_total=None, pricing_status="unknown",
    ))
    unknown_row = next(row for row in service.get_finance_overview("month")["top5_consumers"] if row["org_id"] == unknown_eid)
    assert unknown_row["cost_total"] is None
    assert unknown_row["pricing_status"] == "partial"


def test_finance_reports_has_details(service, enterprise_repo):
    eid = _provision(enterprise_repo, "FinCo2")
    service.execute_action(eid, "recharge", Decimal("300"), None)
    reports = service.get_finance_reports("all")
    assert len(reports["recharge_details"]) == 1
    assert reports["recharge_details"][0]["amount"] == "300"


def test_finance_empty_returns_zeroed(service):
    overview = service.get_finance_overview("all")
    assert overview["total_recharged"] == Decimal("0")
    assert overview["profit_margin"] is None


# ---- 行业方案统计 ----

def test_solution_stats_from_catalog(service, catalog_repo):
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-a", version="1", display_name="Marketing",
    ))
    stats = service.get_solution_stats()
    assert len(stats) >= 1
    assert any(s["solution_id"] == "sol-a" for s in stats)


def test_solution_stats_returns_real_counts(service, catalog_repo, solution_repo):
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-a", version="1", display_name="Marketing",
    ))
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-b", version="1", display_name="Sales",
    ))
    # sol-a applied by two tenants; sol-b applied once by one tenant.
    solution_repo.record_apply(solution_id="sol-a", enterprise_id="ent-1")
    solution_repo.record_apply(solution_id="sol-a", enterprise_id="ent-2")
    solution_repo.record_apply(solution_id="sol-b", enterprise_id="ent-1")

    stats = {s["solution_id"]: s for s in service.get_solution_stats()}
    assert stats["sol-a"]["apply_count"] == 2
    assert stats["sol-a"]["active_enterprises"] == 2
    assert stats["sol-b"]["apply_count"] == 1
    assert stats["sol-b"]["active_enterprises"] == 1


def test_solution_stats_zero_when_unapplied(service, catalog_repo):
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-c", version="1", display_name="Unused",
    ))
    stats = service.get_solution_stats()
    matched = [s for s in stats if s["solution_id"] == "sol-c"]
    assert matched, "sol-c should appear even with zero applications"
    assert matched[0]["apply_count"] == 0
    assert matched[0]["active_enterprises"] == 0


def test_solution_stats_active_enterprises_distinct(service, catalog_repo, solution_repo):
    catalog_repo.create(CatalogEntry(
        catalog_type=CatalogType.SOLUTION_TEMPLATE,
        template_id="sol-d", version="1", display_name="DupApply",
    ))
    # Same enterprise applies the same solution 3 times: apply_count累计, enterprises去重。
    for _ in range(3):
        solution_repo.record_apply(solution_id="sol-d", enterprise_id="ent-x")

    stats = {s["solution_id"]: s for s in service.get_solution_stats()}
    assert stats["sol-d"]["apply_count"] == 3
    assert stats["sol-d"]["active_enterprises"] == 1


# ---- 系统健康 ----

def test_system_health_returns_status(service):
    health = service.get_system_health()
    assert health["status"] in ("healthy", "degraded")
    assert "timestamp" in health
    assert health["services"]["operation"] == "up"


def test_detail_includes_audit_events(service, enterprise_repo, admin_repo):
    eid = _provision(enterprise_repo, "AuditCo")
    service.execute_action(eid, "ban", None, None)
    service.execute_action(eid, "notify", None, "rejected")
    detail = service.get_enterprise_detail(eid)
    assert len(detail["audit_events"]) == 2
    actions = [a["action"] for a in detail["audit_events"]]
    assert "ban" in actions
    assert "notify" in actions


# ---- 通知企业（F17 运营通知窄通道）----

def test_notify_dispatches_to_manager_gateway(enterprise_repo, admin_repo, catalog_repo, rollup_repo, solution_repo):
    """注入 ManagerGateway（F17）：notify 分支应把企业消息经窄通道转给 Manager。"""
    eid = _provision(enterprise_repo, "NotifyCo")
    gw = FakeManagerGateway()
    svc = AdminService(admin_repo, enterprise_repo, catalog_repo, rollup_repo, solution_repo, manager_gateway=gw)
    result = svc.execute_action(eid, "notify", None, "scheduled maintenance")
    assert len(gw.notifications) == 1
    req, key = gw.notifications[0]
    assert req.org_id == eid
    assert req.tenant_id == enterprise_repo.get(eid).tenant_id
    assert req.message == "scheduled maintenance"
    assert key.startswith(f"notify:{eid}:")
    assert "dispatched" in result["detail"]
    audits = admin_repo.list_audit_events(enterprise_id=eid) if hasattr(admin_repo, "list_audit_events") else admin_repo.list_audits(enterprise_id=eid)
    assert audits[0].action == "notify"
    assert "scheduled maintenance" in audits[0].detail


def test_notify_without_gateway_records_local(enterprise_repo, admin_repo):
    """未注入 ManagerGateway 时降级为本地记录（不影响审计轨迹，D14 降级）。"""
    eid = _provision(enterprise_repo, "LocalNotify")
    svc = AdminService(admin_repo, enterprise_repo, CatalogRepository(), CrossEnterpriseRollupRepository(), SolutionRepository())
    result = svc.execute_action(eid, "notify", None, "offline msg")
    assert "offline msg" in result["detail"]
    audits = admin_repo.list_audits(enterprise_id=eid)
    assert len(audits) == 1
    assert audits[0].action == "notify"


# ---- 回归：开通后 admin 页面立即可见（issue AITEAM-292）----

def test_provision_registers_in_admin_repo(admin_repo, enterprise_repo):
    """开通后 AdminRepository 应立即可见，无需先访问详情页触发 _ensure_state。"""
    eid = _provision(enterprise_repo, admin_repo=admin_repo)
    state = admin_repo.get_state(eid)
    assert state.enterprise_name == "Acme"
    assert state.operation_status == "active"


def test_list_enterprises_visible_after_provision(service, admin_repo, enterprise_repo):
    """账号管理列表在开通后应直接显示新企业。"""
    _provision(enterprise_repo, admin_repo=admin_repo, name="Beta")
    rows, total = service.list_enterprises()
    assert total == 1
    assert rows[0]["enterprise_name"] == "Beta"


def test_stats_count_includes_provisioned(service, admin_repo, enterprise_repo):
    """概览统计应在开通后立即反映企业数。"""
    _provision(enterprise_repo, admin_repo=admin_repo, name="Gamma")
    _provision(enterprise_repo, admin_repo=admin_repo, name="Delta")
    stats = service.get_stats()
    assert stats["total_enterprises"] == 2
    assert stats["active_enterprises"] == 2
