"""Loop SQLite 仓储测试（#159）。

验收：SQLite 实现与内存实现行为等价，且重启后数据保持。
"""

import pytest

from agent_service.local_db import apply_migrations, connect
from agent_service.loop.models import Loop, LoopStatus
from agent_service.loop.store import SqliteLoopRepository
from shared.contracts.runspec import RunSpec
from shared.errors import NotFound


@pytest.fixture
def db():
    """内存 SQLite 数据库（每个测试独立）。"""
    db = connect(":memory:")
    apply_migrations(db)
    return db


@pytest.fixture
def repo(db):
    return SqliteLoopRepository(db)


def test_loop_crud(repo):
    """创建、读取、列表。"""
    loop = Loop(id="l1", conversation_id="c1", cron="* * * * *",
                run_spec=RunSpec(system_prompt="hi", model="m1"))
    repo.create(loop)
    retrieved = repo.get("l1")
    assert retrieved.id == "l1"
    assert retrieved.conversation_id == "c1"
    assert retrieved.cron == "* * * * *"
    assert retrieved.run_spec.system_prompt == "hi"
    assert retrieved.status is LoopStatus.DISABLED
    assert repo.list() == [retrieved]


def test_loop_status_transition(repo):
    """状态切换。"""
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    assert repo.get("l1").status is LoopStatus.DISABLED
    enabled = repo.set_status("l1", LoopStatus.ENABLED)
    assert enabled.status is LoopStatus.ENABLED
    assert repo.get("l1").status is LoopStatus.ENABLED
    assert repo.list_enabled() == [repo.get("l1")]
    disabled = repo.set_status("l1", LoopStatus.DISABLED)
    assert disabled.status is LoopStatus.DISABLED
    assert repo.list_enabled() == []


def test_loop_record_fire(repo):
    """触发计数累计。"""
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    repo.record_fire("l1", run_id="run_a")
    repo.record_fire("l1", run_id="run_b")
    loop = repo.get("l1")
    assert loop.fire_count == 2
    assert loop.last_run_id == "run_b"
    assert loop.last_fired_at is not None


def test_loop_list_sorted(repo):
    """列表按 created_at 排序。"""
    repo.create(Loop(id="l2", conversation_id="c1", cron="* * * * *"))
    repo.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    assert [l.id for l in repo.list()] == ["l2", "l1"]


def test_loop_missing_raises_notfound(repo):
    """不存在的 loop 抛 NotFound。"""
    with pytest.raises(NotFound):
        repo.get("nope")
    with pytest.raises(NotFound):
        repo.set_status("nope", LoopStatus.ENABLED)
    with pytest.raises(NotFound):
        repo.record_fire("nope", run_id="run_x")


def test_loop_persistence(db):
    """重启后数据保持。"""
    repo1 = SqliteLoopRepository(db)
    repo1.create(Loop(id="l1", conversation_id="c1", cron="* * * * *"))
    repo1.set_status("l1", LoopStatus.ENABLED)
    # 新建仓储实例，复用同一 db
    repo2 = SqliteLoopRepository(db)
    loop = repo2.get("l1")
    assert loop.id == "l1"
    assert loop.status is LoopStatus.ENABLED
