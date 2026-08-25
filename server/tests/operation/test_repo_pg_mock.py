"""Pg*仓储的 mock 单元测试（无需真实 PostgreSQL，标 `not integration`）。

用 mock 替代真实 PostgreSQL，覆盖各仓储 PG 实现类的每一个方法路径、SQL 分支以及
行为契约。每个仓储至少验证：CRUD 入口调用了对应 SQL、抽象基类的签名实现一致，以及
DI 契约（``admin_db_url`` 有值 → PG，无值 → 内存现成实现）。

共享的 ``_install_psycopg`` 在 ``sys.modules['psycopg']`` 注入一个 fake，其
``connect()`` 返回可逐方法编排的 ``_FakeConn`` / ``_FakeCursor``。
"""

import sys
from datetime import datetime, timezone
from decimal import Decimal

import pytest

import operation_service.admin_dependencies as admin_deps
import operation_service.dependencies as deps
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.summary import UsageSummary
from shared.errors import NotFound

# ---------------------------------------------------------------------------
# 共享 fake-psycopg 工具
# ---------------------------------------------------------------------------


class _FakeCursor:
    """模拟 psycopg cursor。可逐次 execute 编排返回。"""

    def __init__(self):
        self.calls = []          # (sql, params)
        # 编排队列：每次 execute 依次取出一个回调来设置返回值。
        self._queue = []
        self._fetchone = None
        self._fetchall = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.calls.append((sql, params or ()))
        if self._queue:
            fn = self._queue.pop(0)
            fn(self)
        return self

    def fetchone(self):
        return self._fetchone

    def fetchall(self):
        out = self._fetchall
        return out

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_psycopg(monkeypatch, conn):
    """注入 fake ``psycopg.connect``（返回 conn），并保留 errors/sql 模块。"""
    import psycopg.errors as real_errors
    import psycopg.sql as real_sql

    fake = type("psycopg", (), {"connect": staticmethod(lambda dsn, **kw: conn)})()
    fake.errors = real_errors
    fake.sql = real_sql
    monkeypatch.setitem(sys.modules, "psycopg", fake)


def _set_one(cursor, row):
    cursor._queue.append(lambda c: setattr(c, "_fetchone", row))


def _set_all(cursor, rows):
    cursor._queue.append(lambda c: setattr(c, "_fetchall", rows))


def _noop(cursor):
    pass


def _dt(y=2026, m=1, d=1):
    return datetime(y, m, d, tzinfo=timezone.utc)


# 一行企业账号 SELECT（_fetch_state / list_enterprises / top_consumers 共用列序）
_ACC_COLS = (
    "ent-1", "Test Corp", "13800000000", "active", Decimal("0"),
    _dt(), None, None, None, None, None,
)


# ===========================================================================
# AdminRepository PG
# ===========================================================================


class TestPgAdminRepository:
    @pytest.fixture
    def repo(self, monkeypatch):
        from operation_service.admin_repository import PgAdminRepository
        self.cursor = _FakeCursor()
        self.conn = _FakeConn(self.cursor)
        _install_psycopg(monkeypatch, self.conn)
        return PgAdminRepository("postgresql://test")

    # ---- upsert / register ----

    def test_register_existing_row_updates(self, repo):
        # SELECT 1 -> exists -> UPDATE; then _fetch_state SELECT returns _ACC_COLS.
        _set_one(self.cursor, (1,))          # existence check: found
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state
        state = repo.register_enterprise("ent-1", "Test Corp", "138")
        assert state.enterprise_id == "ent-1"
        assert any("UPDATE enterprise_account" in s for s, _ in self.cursor.calls)

    def test_register_new_row_inserts(self, repo):
        _set_one(self.cursor, None)          # existence check: not found -> INSERT
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state
        state = repo.register_enterprise("ent-1", "New Corp", "138")
        assert state.enterprise_id == "ent-1"
        assert any("INSERT INTO enterprise_account" in s for s, _ in self.cursor.calls)

    def test_get_state_not_found(self, repo):
        _set_one(self.cursor, None)
        with pytest.raises(NotFound, match="admin state not found"):
            repo.get_state("missing")

    def test_get_state_naive_datetime_gets_utc(self, repo):
        row = _ACC_COLS[:5] + (datetime(2026, 1, 1),) + _ACC_COLS[6:]
        _set_one(self.cursor, row)
        state = repo.get_state("ent-1")
        assert state.registered_at.tzinfo is not None

    # ---- set_status / set_operation_status / apply_action ----

    def test_set_status_invokes_transition(self, repo):
        # set_status -> set_operation_status(_fetch_state + UPDATE + _fetch_state)
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state (current active)
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state after update
        repo.set_status("ent-1", "suspended")
        assert any("UPDATE enterprise_account" in s for s, _ in self.cursor.calls)

    def test_set_operation_status_noop_when_same(self, repo):
        cur_active = _ACC_COLS
        _set_one(self.cursor, cur_active)    # _fetch_state
        state = repo.set_operation_status("ent-1", "active", normalized=True)
        assert state.operation_status == "active"
        # 仅一次 SELECT，无 UPDATE
        assert all("UPDATE" not in s for s, _ in self.cursor.calls)

    def test_set_operation_status_reason_banned(self, repo):
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state current
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state after
        repo.set_operation_status("ent-1", "banned", reason="abuse")
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "UPDATE enterprise_account" in joined

    def test_apply_action_suspend_changes_status(self, repo):
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state
        _set_one(self.cursor, _ACC_COLS)     # _fetch_state after transition
        new = repo.apply_action("ent-1", "suspend")
        assert new == "suspended"

    def test_apply_action_noop_when_same(self, repo):
        # active -> reactivate stays active
        _set_one(self.cursor, _ACC_COLS)
        new = repo.apply_action("ent-1", "reactivate")
        assert new == "active"

    # ---- add_recharge ----

    def test_add_recharge(self, repo):
        _set_one(self.cursor, ("rchg-1", "ent-1", Decimal("50"), _dt()))
        rec = repo.add_recharge("ent-1", Decimal("50"))
        assert rec.recharge_id == "rchg-1"
        assert rec.amount == Decimal("50")
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "INSERT INTO operation_recharge_record" in joined
        assert "UPDATE enterprise_account" in joined

    def test_add_recharge_naive_datetime(self, repo):
        _set_one(self.cursor, ("rchg-1", "ent-1", Decimal("50"), datetime(2026, 1, 1)))
        rec = repo.add_recharge("ent-1", Decimal("50"))
        assert rec.created_at.tzinfo is not None

    # ---- quota ----

    def test_ensure_quota_inserts_and_reads(self, repo):
        row = ("ent-1", 5, 1, 100, 10, 60, 5, 1000, 200)
        _noop(self.cursor)  # INSERT (no fetch)
        _set_one(self.cursor, row)  # SELECT quota
        q = repo.ensure_quota("ent-1")
        assert q.enterprise_id == "ent-1"
        assert q.employee_limit == 5
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "INSERT INTO operation_enterprise_quota" in joined

    def test_get_quota_delegates(self, repo):
        row = ("ent-1", -1, 0, -1, 0, -1, 0, -1, 0)
        _noop(self.cursor)
        _set_one(self.cursor, row)
        q = repo.get_quota("ent-1")
        assert q.token_quota_limit == -1

    def test_update_quota_with_dims(self, repo):
        # ensure_quota (INSERT noop + SELECT), UPDATE, then ensure_quota again.
        _noop(self.cursor)
        _set_one(self.cursor, ("ent-1", -1, 0, -1, 0, -1, 0, -1, 0))
        _noop(self.cursor)  # UPDATE
        _noop(self.cursor)  # INSERT in 2nd ensure
        _set_one(self.cursor, ("ent-1", 10, 0, -1, 0, -1, 0, -1, 0))
        q = repo.update_quota("ent-1", employee_limit=10)
        assert q.employee_limit == 10
        assert any("UPDATE operation_enterprise_quota SET" in s for s, _ in self.cursor.calls)

    def test_update_quota_empty_dims(self, repo):
        _noop(self.cursor)
        _set_one(self.cursor, ("ent-1", -1, 0, -1, 0, -1, 0, -1, 0))
        q = repo.update_quota("ent-1")
        assert q.enterprise_id == "ent-1"

    # ---- record_audit ----

    def test_record_audit(self, repo):
        _set_one(self.cursor, ("evt-1", _dt()))
        evt = repo.record_audit("ent-1", "action", "detail", actor_id="u1", severity="warning")
        assert evt.event_id == "evt-1"
        assert evt.actor_id == "u1"

    def test_record_audit_naive_datetime(self, repo):
        _set_one(self.cursor, ("evt-1", datetime(2026, 1, 1)))
        evt = repo.record_audit("ent-1", "a", "d")
        assert evt.created_at.tzinfo is not None

    # ---- listings ----

    def test_list_enterprises_filtered(self, repo):
        _set_all(self.cursor, [_ACC_COLS])
        rows = repo.list_enterprises(keyword="test", status="active")
        assert len(rows) == 1
        assert rows[0].enterprise_id == "ent-1"
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "WHERE" in joined and "ORDER BY created_at DESC" in joined

    def test_list_enterprises_naive_datetime(self, repo):
        row = _ACC_COLS[:5] + (datetime(2026, 1, 1),) + _ACC_COLS[6:]
        _set_all(self.cursor, [row])
        rows = repo.list_enterprises()
        assert rows[0].registered_at.tzinfo is not None

    def test_list_recharges_all(self, repo):
        _set_all(self.cursor, [("r1", "ent-1", Decimal("10"), _dt())])
        recs = repo.list_recharges()
        assert recs[0].recharge_id == "r1"

    def test_list_recharges_for_enterprise(self, repo):
        _set_all(self.cursor, [("r1", "ent-1", Decimal("10"), _dt())])
        recs = repo.list_recharges("ent-1")
        assert len(recs) == 1
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "WHERE enterprise_id" in joined

    def test_list_recharges_naive_datetime(self, repo):
        _set_all(self.cursor, [("r1", "ent-1", Decimal("10"), datetime(2026, 1, 1))])
        recs = repo.list_recharges()
        assert recs[0].created_at.tzinfo is not None

    def test_list_audits_returns_legacy(self, repo):
        # _fetch_audits: COUNT then SELECT rows.
        _set_one(self.cursor, (2,))
        _set_all(self.cursor, [(
            "evt-1", "ent-1", "action", "detail", None, None,
            "info", "success", None, None, _dt(),
        )])
        audits = repo.list_audits("ent-1")
        assert len(audits) == 1
        assert audits[0].action == "action"

    def test_list_enriched_audits(self, repo):
        _set_one(self.cursor, (1,))
        _set_all(self.cursor, [(
            "evt-1", "ent-1", "action", "detail", "u1", "name",
            "info", "success", None, None, _dt(),
        )])
        events, total = repo.list_enriched_audits(severity="info", cursor=0, limit=10)
        assert total == 1
        assert events[0].actor_name == "name"

    def test_list_enriched_audits_naive_datetime(self, repo):
        _set_one(self.cursor, (1,))
        _set_all(self.cursor, [(
            "evt-1", "ent-1", "a", "d", None, None,
            "info", "success", None, None, datetime(2026, 1, 1),
        )])
        events, _ = repo.list_enriched_audits()
        assert events[0].created_at.tzinfo is not None

    # ---- aggregates ----

    def test_total_recharged_all(self, repo):
        _set_one(self.cursor, (Decimal("123"),))
        assert repo.total_recharged_all() == Decimal("123")

    def test_enterprise_count(self, repo):
        _set_one(self.cursor, (7,))
        assert repo.enterprise_count() == 7

    def test_new_this_month(self, repo):
        _set_one(self.cursor, (3,))
        assert repo.new_this_month() == 3

    def test_monthly_active(self, repo):
        _set_one(self.cursor, (2,))
        assert repo.monthly_active() == 2

    def test_top_consumers(self, repo):
        _set_all(self.cursor, [_ACC_COLS])
        rows = repo.top_consumers(5)
        assert rows[0].enterprise_id == "ent-1"

    def test_top_consumers_naive_datetime(self, repo):
        row = _ACC_COLS[:5] + (datetime(2026, 1, 1),) + _ACC_COLS[6:]
        _set_all(self.cursor, [row])
        rows = repo.top_consumers()
        assert rows[0].registered_at.tzinfo is not None

    def test_recharge_trend(self, repo):
        _set_all(self.cursor, [("2026-01", Decimal("50"))])
        trend = repo.recharge_trend("2026-01")
        assert trend == [{"period": "2026-01", "amount": "50"}]

    def test_inherits_base(self):
        from operation_service.admin_repository import AdminRepositoryBase, PgAdminRepository
        assert issubclass(PgAdminRepository, AdminRepositoryBase)


# ===========================================================================
# RollupRepository PG
# ===========================================================================


class TestPgRollupRepository:
    @pytest.fixture
    def repo(self, monkeypatch):
        from operation_service.rollup_repository import PgRollupRepository
        self.cursor = _FakeCursor()
        self.conn = _FakeConn(self.cursor)
        _install_psycopg(monkeypatch, self.conn)
        return PgRollupRepository("postgresql://test")

    def _summary(self, sid="s1"):
        return UsageSummary(
            summary_id=sid, tenant_id="t1",
            window_start=_dt(2026, 1, 1), window_end=_dt(2026, 1, 2),
            run_count=3, token_total=300, cost_total=Decimal("4.5"),
            error_count=1, duration_seconds_total=10,
        )

    def test_apply_summary_executes_upsert_and_recompute(self, repo):
        _noop(self.cursor)
        _noop(self.cursor)
        repo.apply_summary("ent-1", "t1", self._summary())
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "operation_rollup_seen" in joined
        assert "cross_enterprise_usage_rollup" in joined

    def test_get_found(self, repo):
        row = (3, 300, Decimal("4.5"), 0, 0, 1, 10, 1, _dt(), _dt(), "t1")
        _set_one(self.cursor, row)
        result = repo.get("ent-1")
        assert result.run_count == 3
        assert result.tenant_id == "t1"

    def test_get_not_found_raises(self, repo):
        _set_one(self.cursor, None)
        with pytest.raises(NotFound, match="rollup not found"):
            repo.get("missing")

    def test_list_all(self, repo):
        _set_all(self.cursor, [(
            "ent-1", "t1", 3, 300, Decimal("4.5"), 0, 0, 1, 10, 1, _dt(), _dt(),
        )])
        rows = repo.list_all()
        assert rows[0].enterprise_id == "ent-1"
        assert rows[0].run_count == 3

    def test_summaries_for_with_tenant(self, repo):
        _set_one(self.cursor, ("t1",))  # tenant lookup
        _set_all(self.cursor, [(
            "s1", _dt(), _dt(), 3, 300, Decimal("4.5"), 1, 10, 1, "known", "USD",
        )])
        rows = repo.summaries_for("ent-1")
        assert rows[0].summary_id == "s1"
        assert rows[0].tenant_id == "t1"

    def test_summaries_for_unknown_enterprise(self, repo):
        _set_one(self.cursor, None)  # no tenant row
        _set_all(self.cursor, [])
        rows = repo.summaries_for("missing")
        assert rows == []

    def test_all_summaries(self, repo):
        _set_all(self.cursor, [(
            "ent-1", "s1", _dt(), _dt(), 3, 300, Decimal("4.5"), 1, 10, 1, "known", "USD", "t1",
        )])
        rows = repo.all_summaries()
        assert rows[0][0] == "ent-1"
        assert rows[0][1].summary_id == "s1"

    def test_to_summary_handles_nulls(self, repo):
        from operation_service.rollup_repository import PgRollupRepository
        s = PgRollupRepository._to_summary("t1", ("s1", _dt(), _dt(), None, None, None, None, None, None, "unknown", "USD"))
        assert s.run_count == 0
        assert s.cost_total == Decimal("0")

    def test_inherits_base(self):
        from operation_service.rollup_repository import (
            CrossEnterpriseRollupRepositoryBase, PgRollupRepository,
        )
        assert issubclass(PgRollupRepository, CrossEnterpriseRollupRepositoryBase)


# ===========================================================================
# CatalogRepository PG
# ===========================================================================


class TestPgCatalogRepository:
    @pytest.fixture
    def repo(self, monkeypatch):
        from operation_service.catalog_repository import PgCatalogRepository
        self.cursor = _FakeCursor()
        self.conn = _FakeConn(self.cursor)
        _install_psycopg(monkeypatch, self.conn)
        return PgCatalogRepository("postgresql://test")

    def _entry(self, tid="t1", status=CatalogStatus.DRAFT):
        from operation_service.catalog_repository import CatalogEntry
        return CatalogEntry(
            catalog_type=CatalogType.EXPERT_TEMPLATE, template_id=tid,
            version="1", display_name="X", status=status,
            visible_scope={"k": "v"}, payload={"p": 1},
        )

    def test_create_inserts_when_absent(self, repo):
        _set_one(self.cursor, None)   # _exists -> absent
        _noop(self.cursor)            # INSERT
        entry = repo.create(self._entry())
        assert entry.template_id == "t1"
        assert any("INSERT INTO catalog_template" in s for s, _ in self.cursor.calls)

    def test_create_wraps_jsonb_fields(self, repo):
        """psycopg3 cannot adapt Python dicts; visible_scope/payload must be Json()."""
        from psycopg.types.json import Json
        _set_one(self.cursor, None)   # _exists -> absent
        _noop(self.cursor)            # INSERT
        repo.create(self._entry())
        insert_calls = [p for s, p in self.cursor.calls if "INSERT INTO catalog_template" in s]
        assert insert_calls, "INSERT was not called"
        params = insert_calls[0]
        # visible_scope (index 5) and payload (index 6) must be Json instances
        assert isinstance(params[5], Json), f"visible_scope not Json: {type(params[5])}"
        assert isinstance(params[6], Json), f"payload not Json: {type(params[6])}"

    def test_create_wraps_none_visible_scope(self, repo):
        """None visible_scope should be passed as None, not Json(None)."""
        from operation_service.catalog_repository import CatalogEntry
        entry = CatalogEntry(
            catalog_type=CatalogType.EXPERT_TEMPLATE, template_id="t2",
            version="1", display_name="X", visible_scope=None, payload={"p": 1},
        )
        _set_one(self.cursor, None)
        _noop(self.cursor)
        repo.create(entry)
        insert_calls = [p for s, p in self.cursor.calls if "INSERT INTO catalog_template" in s]
        params = insert_calls[0]
        assert params[5] is None, f"visible_scope should be None: {params[5]}"

    def test_update_wraps_jsonb_fields(self, repo):
        """update() must also wrap visible_scope/payload with Json()."""
        from psycopg.types.json import Json
        _noop(self.cursor)  # UPDATE
        repo.update(self._entry(), status=CatalogStatus.PUBLISHED)
        update_calls = [p for s, p in self.cursor.calls if "UPDATE catalog_template SET" in s]
        assert update_calls, "UPDATE was not called"
        params = update_calls[0]
        assert isinstance(params[3], Json), f"visible_scope not Json: {type(params[3])}"
        assert isinstance(params[4], Json), f"payload not Json: {type(params[4])}"

    def test_create_conflict_when_exists(self, repo):
        from shared.errors import Conflict
        _set_one(self.cursor, (1,))   # _exists -> present
        with pytest.raises(Conflict, match="already exists"):
            repo.create(self._entry())

    def test_get_found(self, repo):
        _set_one(self.cursor, (
            "expert_template", "t1", "1", "X", "draft", {"k": "v"}, {"p": 1},
        ))
        entry = repo.get(CatalogType.EXPERT_TEMPLATE, "t1")
        assert entry.display_name == "X"

    def test_get_not_found(self, repo):
        _set_one(self.cursor, None)
        with pytest.raises(NotFound, match="catalog entry not found"):
            repo.get(CatalogType.EXPERT_TEMPLATE, "missing")

    def test_update_runs_update(self, repo):
        _noop(self.cursor)  # UPDATE
        from operation_service.catalog_repository import CatalogStatus as CS
        result = repo.update(self._entry(), status=CS.PUBLISHED)
        assert result.status == CS.PUBLISHED
        assert any("UPDATE catalog_template SET" in s for s, _ in self.cursor.calls)

    def test_list_with_filters(self, repo):
        _set_all(self.cursor, [(
            "expert_template", "t1", "1", "X", "draft", {"k": "v"}, {"p": 1},
        )])
        rows = repo.list(catalog_type=CatalogType.EXPERT_TEMPLATE, status=CatalogStatus.DRAFT)
        assert len(rows) == 1
        joined = "\n".join(s for s, _ in self.cursor.calls)
        assert "WHERE" in joined and "ORDER BY template_id" in joined

    def test_row_to_entry(self):
        from operation_service.catalog_repository import (
            CatalogType as CT, CatalogStatus as CS, PgCatalogRepository,
        )
        entry = PgCatalogRepository._row_to_entry((
            "solution_template", "t1", "1", "X", "published", None, {},
        ))
        assert entry.catalog_type == CT.SOLUTION_TEMPLATE
        assert entry.status == CS.PUBLISHED

    def test_inherits_base(self):
        from operation_service.catalog_repository import (
            CatalogRepositoryBase, PgCatalogRepository,
        )
        assert issubclass(PgCatalogRepository, CatalogRepositoryBase)


# ===========================================================================
# SolutionRepository PG
# ===========================================================================


class TestPgSolutionRepository:
    @pytest.fixture
    def repo(self, monkeypatch):
        from operation_service.solution_repository import PgSolutionRepository
        self.cursor = _FakeCursor()
        self.conn = _FakeConn(self.cursor)
        _install_psycopg(monkeypatch, self.conn)
        return PgSolutionRepository("postgresql://test")

    def test_record_apply_inserts(self, repo):
        _noop(self.cursor)
        repo.record_apply(solution_id="sol-1", enterprise_id="ent-1")
        assert any("INSERT INTO solution_stat" in s for s, _ in self.cursor.calls)

    def test_record_apply_skips_when_not_applied(self, repo):
        repo.record_apply(solution_id="sol-1", enterprise_id="ent-1", applied=False)
        assert self.cursor.calls == []  # no DB calls at all

    def test_get_stats(self, repo):
        _set_one(self.cursor, (2, 1))
        stats = repo.get_stats("sol-1")
        assert stats == {"apply_count": 2, "active_enterprises": 1}

    def test_list_stats(self, repo):
        _set_all(self.cursor, [("sol-1", 3, 2)])
        stats = repo.list_stats()
        assert stats["sol-1"] == {"apply_count": 3, "active_enterprises": 2}

    def test_inherits_base(self):
        from operation_service.solution_repository import (
            PgSolutionRepository, SolutionRepositoryBase,
        )
        assert issubclass(PgSolutionRepository, SolutionRepositoryBase)


# ===========================================================================
# DI factory 切换（内存 ↔ PG）
# ===========================================================================


class TestDIFactoryBranch:
    @pytest.fixture(autouse=True)
    def _reset(self, monkeypatch):
        from operation_service import dependencies as d
        from operation_service import admin_dependencies as a
        from operation_service import catalog_dependencies as c
        monkeypatch.setattr(d, "apply_migrations", lambda *x, **y: None)
        monkeypatch.setattr(a, "apply_migrations", lambda *x, **y: None)
        monkeypatch.setattr(c, "apply_migrations", lambda *x, **y: None)
        d.get_repository.cache_clear()
        d.get_admin_repository.cache_clear()
        d.get_rollup_repository.cache_clear()
        a.get_solution_repository.cache_clear()
        c.get_catalog_repository.cache_clear()

    def test_all_memory_when_no_db(self, monkeypatch):
        for k in ("ADMIN_DB_URL", "DB_URL", "APP_RW_PASSWORD"):
            monkeypatch.delenv(k, raising=False)
        from operation_service import catalog_dependencies as cd
        from operation_service.admin_repository import AdminRepository
        from operation_service.catalog_repository import CatalogRepository
        from operation_service.repository import InMemoryEnterpriseRepository
        from operation_service.rollup_repository import CrossEnterpriseRollupRepository
        from operation_service.solution_repository import SolutionRepository
        assert isinstance(deps.get_repository(), InMemoryEnterpriseRepository)
        assert isinstance(deps.get_admin_repository(), AdminRepository)
        assert isinstance(deps.get_rollup_repository(), CrossEnterpriseRollupRepository)
        assert isinstance(admin_deps.get_solution_repository(), SolutionRepository)
        assert isinstance(cd.get_catalog_repository(), CatalogRepository)

    def test_all_pg_when_db_set(self, monkeypatch):
        monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@localhost/oper")
        monkeypatch.setenv("APP_RW_PASSWORD", "secret")
        from operation_service import catalog_dependencies as cd
        from operation_service.admin_repository import PgAdminRepository
        from operation_service.catalog_repository import PgCatalogRepository
        from operation_service.repository import PgEnterpriseRepository
        from operation_service.rollup_repository import PgRollupRepository
        from operation_service.solution_repository import PgSolutionRepository
        assert isinstance(deps.get_repository(), PgEnterpriseRepository)
        assert isinstance(deps.get_admin_repository(), PgAdminRepository)
        assert isinstance(deps.get_rollup_repository(), PgRollupRepository)
        assert isinstance(admin_deps.get_solution_repository(), PgSolutionRepository)
        assert isinstance(cd.get_catalog_repository(), PgCatalogRepository)
