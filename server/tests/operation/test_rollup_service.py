"""跨企业 rollup 聚合服务单测（04 §6.5，D13）。

覆盖：企业级摘要入库聚合、summary_id 幂等去重、跨企业看板合计、红线（仅脱敏聚合、
不下钻租户明细）。对端 Manager 上报用直接构造的 UsageSummary（脱敏聚合单元）。
"""

from datetime import datetime
from decimal import Decimal

from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.rollup_schemas import EnterpriseRollupUpload
from operation_service.rollup_service import RollupService
from shared.contracts.summary import UsageSummary


def _summary(summary_id: str, tenant: str, **kw) -> UsageSummary:
    base = dict(
        summary_id=summary_id,
        tenant_id=tenant,
        window_start=datetime(2026, 6, 1),
        window_end=datetime(2026, 6, 2),
        run_count=1,
        token_total=100,
        cost_total=Decimal("1.50"),
        error_count=0,
        duration_seconds_total=10,
    )
    base.update(kw)
    return UsageSummary(**base)


def _service() -> RollupService:
    return RollupService(CrossEnterpriseRollupRepository())


def _upload(ent: str, tenant: str, summaries: list[UsageSummary]) -> EnterpriseRollupUpload:
    return EnterpriseRollupUpload(enterprise_id=ent, tenant_id=tenant, summaries=summaries)


def test_ingest_aggregates_enterprise_totals():
    svc = _service()
    svc.ingest(_upload("ent-a", "t-a", [
        _summary("s1", "t-a", token_total=100, cost_total=Decimal("1.50"), run_count=2),
        _summary("s2", "t-a", token_total=50, cost_total=Decimal("0.50"), run_count=1, error_count=1),
    ]))

    board = svc.cross_enterprise_board()
    assert board.enterprise_count == 1
    row = board.enterprises[0]
    assert row.enterprise_id == "ent-a"
    assert row.run_count == 3
    assert row.token_total == 150
    assert row.cost_total == Decimal("2.00")
    assert row.error_count == 1
    assert row.summary_count == 2


def test_summary_id_idempotent_dedup():
    """同一 summary_id 重复上报只计一次（04 §6.5 幂等去重）。"""
    svc = _service()
    s = _summary("dup", "t-a", token_total=100, cost_total=Decimal("1.00"))
    svc.ingest(_upload("ent-a", "t-a", [s]))
    svc.ingest(_upload("ent-a", "t-a", [s]))  # 重传同 summary_id

    row = svc.cross_enterprise_board().enterprises[0]
    assert row.token_total == 100  # 不翻倍
    assert row.summary_count == 1


def test_cross_enterprise_rollup_sums_all_tenants():
    """跨企业 rollup：平台合计是各企业之和，且不下钻租户内部明细。"""
    svc = _service()
    svc.ingest(_upload("ent-a", "t-a", [
        _summary("a1", "t-a", token_total=100, cost_total=Decimal("1.00"), run_count=1),
    ]))
    svc.ingest(_upload("ent-b", "t-b", [
        _summary("b1", "t-b", token_total=200, cost_total=Decimal("2.00"), run_count=3, error_count=2),
    ]))

    board = svc.cross_enterprise_board()
    assert board.enterprise_count == 2
    assert board.run_count == 4
    assert board.token_total == 300
    assert board.cost_total == Decimal("3.00")
    assert board.error_count == 2
    # 红线：看板字段只有聚合数字，无成员/会话/employee 明细下钻通道。
    dumped = board.model_dump()
    for row in dumped["enterprises"]:
        assert set(row).issubset({
            "enterprise_id", "tenant_id", "run_count", "token_total", "cost_total",
            "error_count", "duration_seconds_total", "summary_count",
            "window_start", "window_end",
        })


def test_window_bounds_track_min_max():
    svc = _service()
    svc.ingest(_upload("ent-a", "t-a", [
        _summary("w1", "t-a", window_start=datetime(2026, 6, 1), window_end=datetime(2026, 6, 5)),
        _summary("w2", "t-a", window_start=datetime(2026, 5, 20), window_end=datetime(2026, 6, 10)),
    ]))
    row = svc.cross_enterprise_board().enterprises[0]
    assert row.window_start == datetime(2026, 5, 20)
    assert row.window_end == datetime(2026, 6, 10)


def test_empty_board_is_zeroed():
    board = _service().cross_enterprise_board()
    assert board.enterprise_count == 0
    assert board.run_count == 0
    assert board.cost_total == Decimal("0")
    assert board.enterprises == []


def test_get_enterprise_rollup_single():
    svc = _service()
    svc.ingest(_upload("ent-a", "t-a", [_summary("s1", "t-a", token_total=42)]))
    row = svc.enterprise_rollup("ent-a")
    assert row.enterprise_id == "ent-a"
    assert row.token_total == 42


def test_get_unknown_enterprise_returns_zeroed_rollup():
    """未知企业返回全零聚合而非 NotFound/404（GH#328）。"""
    row = _service().enterprise_rollup("nope")
    assert row.enterprise_id == "nope"
    assert row.tenant_id == ""
    assert row.run_count == 0
    assert row.token_total == 0
    assert row.cost_total == Decimal("0")
    assert row.error_count == 0
    assert row.duration_seconds_total == 0
    assert row.summary_count == 0
    assert row.window_start is None
    assert row.window_end is None


# ---- 回归：看板企业数包含已注册但无使用的企业（issue AITEAM-292）----

def test_board_includes_registered_zero_usage_enterprises():
    """概览/跨企业看板的 enterprise_count 应包含所有已注册企业，含零使用。"""
    from operation_service.admin_repository import AdminRepository

    admin_repo = AdminRepository()
    admin_repo.register_enterprise("ent-x", "Enterprise X")
    admin_repo.register_enterprise("ent-y", "Enterprise Y")

    svc = RollupService(CrossEnterpriseRollupRepository(), admin_repo=admin_repo)
    board = svc.cross_enterprise_board()

    assert board.enterprise_count == 2
    ids = {e.enterprise_id for e in board.enterprises}
    assert ids == {"ent-x", "ent-y"}
    # 零使用企业的指标应为零
    for e in board.enterprises:
        assert e.run_count == 0
        assert e.token_total == 0


def test_board_merges_usage_and_registered():
    """有使用数据的企业 + 已注册无使用的企业，看板都应显示。"""
    from operation_service.admin_repository import AdminRepository

    admin_repo = AdminRepository()
    admin_repo.register_enterprise("ent-registered", "Registered Co")

    repo = CrossEnterpriseRollupRepository()
    svc = RollupService(repo, admin_repo=admin_repo)
    svc.ingest(_upload("ent-usage", "t-1", [
        _summary("s1", "t-1", token_total=100, cost_total=Decimal("1.00")),
    ]))

    board = svc.cross_enterprise_board()
    assert board.enterprise_count == 2
    ids = {e.enterprise_id for e in board.enterprises}
    assert ids == {"ent-registered", "ent-usage"}


def test_board_without_admin_repo_unchanged():
    """不注入 admin_repo 时行为不变（仅显示有 rollup 数据的企业）。"""
    svc = _service()
    svc.ingest(_upload("ent-a", "t-a", [
        _summary("s1", "t-a", token_total=100, cost_total=Decimal("1.00")),
    ]))
    board = svc.cross_enterprise_board()
    assert board.enterprise_count == 1
