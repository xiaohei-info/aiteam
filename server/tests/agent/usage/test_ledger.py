"""A5 审计回流验收：UsageLedger token 级计量明细（#293）。

覆盖：单 run 明细幂等 upsert、按 employee 列表与分组聚合、重启持久化。
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.usage.ledger import (
    InMemoryUsageLedgerRepository,
    SqliteUsageLedgerRepository,
    UsageLedger,
    _to_cents,
)


def _item(**overrides) -> UsageLedger:
    base = dict(
        tenant_id="t1",
        employee_id="e1",
        run_id="r1",
        conversation_id="c1",
        input_tokens=10,
        output_tokens=5,
        total_tokens=15,
        cost_cents=_to_cents("0.0030"),
        error=False,
        duration_seconds=3,
        source_type="run_summary",
        occurred_at=datetime(2026, 6, 18, 10, 0, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return UsageLedger(**base)


@pytest.fixture
def mem():
    return InMemoryUsageLedgerRepository()


@pytest.fixture
def db():
    db = connect(":memory:")
    apply_migrations(db)
    return db


@pytest.fixture
def sqlite(db):
    return SqliteUsageLedgerRepository(db)


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_upsert_is_idempotent_by_run_and_source(repo, request):
    r = request.getfixturevalue(repo)
    a = r.upsert(_item(run_id="r1", source_type="run_summary", input_tokens=1, output_tokens=1, total_tokens=2))
    b = r.upsert(_item(run_id="r1", source_type="run_summary", input_tokens=10, output_tokens=5, total_tokens=15))
    assert b.input_tokens == 10
    assert b.id == a.id  # 同一 run+source 复写，不新增行
    # 同一 run、不同 source_type 视为独立行
    c = r.upsert(_item(run_id="r1", source_type="backfill", total_tokens=99))
    assert c.id != a.id


def test_normalized_total_falls_back_to_sum():
    item = _item(total_tokens=0, input_tokens=7, output_tokens=3)
    assert item.normalized_total() == 10
    item2 = _item(total_tokens=42, input_tokens=1, output_tokens=1)
    assert item2.normalized_total() == 42


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_list_by_employee_and_get(repo, request):
    r = request.getfixturevalue(repo)
    r.upsert(_item(run_id="r1", employee_id="e1", total_tokens=10))
    r.upsert(_item(run_id="r2", employee_id="e1", total_tokens=20))
    r.upsert(_item(run_id="r3", employee_id="e2", total_tokens=99))
    rows = r.list_by_employee("e1")
    assert [i.run_id for i in rows] == ["r1", "r2"]
    got = r.get("r1", "run_summary")
    assert got is not None and got.normalized_total() == 10
    assert r.get("nope", "run_summary") is None


@pytest.mark.parametrize("repo", ["mem", "sqlite"])
def test_aggregate_by_employee(repo, request):
    r = request.getfixturevalue(repo)
    r.upsert(_item(run_id="r1", employee_id="e1", total_tokens=10, cost_cents=_to_cents("0.01"), error=True))
    r.upsert(_item(run_id="r2", employee_id="e1", total_tokens=5, cost_cents=_to_cents("0.01")))
    r.upsert(_item(run_id="r3", employee_id="e2", total_tokens=100, cost_cents=_to_cents("0.10")))
    agg = r.aggregate_by_employee()
    assert agg["e1"]["run_count"] == 2
    assert agg["e1"]["token_total"] == 15
    assert agg["e1"]["cost_cents_total"] == _to_cents("0.02")
    assert agg["e1"]["error_count"] == 1
    assert agg["e2"]["run_count"] == 1 and agg["e2"]["token_total"] == 100


def test_sqlite_persists_across_repos(db):
    r1 = SqliteUsageLedgerRepository(db)
    r1.upsert(_item(run_id="r1", employee_id="e1", total_tokens=123))
    r2 = SqliteUsageLedgerRepository(db)
    got = r2.get("r1", "run_summary")
    assert got is not None and got.normalized_total() == 123
    assert r2.aggregate_by_employee()["e1"]["run_count"] == 1


def test_to_cents_no_float_rounding():
    # 0.10 元反复 10 次不应出现 99/101 分毛边。
    assert _to_cents("0.10") == 10
    assert sum(_to_cents("0.10") for _ in range(10)) == 100


def test_model_rejects_unknown_fields():
    with pytest.raises(Exception):  # pydantic ValidationError
        UsageLedger(run_id="r1", tenant_id="t1", bogus_field="x")  # type: ignore[call-arg]
