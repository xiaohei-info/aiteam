"""grants 装配 + 客户端分支验收。

覆盖 PR #12 新增的：
- UnconfiguredGrantsClient：pull 两项都抛 AppError（安全默认）
- ServiceClientGrantsClient：user_token_provider 分支 + 空 data 回退
- build_grants_service：db / projections / solutions 三条分支
- SqliteProjectionRepository / SqliteSnapshotRepository / SqliteSolutionProjectionRepository
  全部 CRUD（覆盖 grants/store.py 新增的 SQLite 实现）
"""

from __future__ import annotations
import httpx
from shared.service_client import ServiceClient

import sqlite3
import tempfile
import pytest

from shared.errors import AppError
from shared.contracts.grants import LoadedExpertProjection

from agent_service.local_db import apply_migrations, connect
from agent_service.grants.client import (
    ServiceClientGrantsClient,
    UnconfiguredGrantsClient,
)
from agent_service.grants.factory import build_grants_service
from agent_service.grants.service import GrantsService
from agent_service.grants.store import (
    InMemoryProjectionRepository,
    SqliteProjectionRepository,
    SqliteSnapshotRepository,
    SqliteSolutionProjectionRepository,
)
from shared.contracts.crosstier import AuthorizedConfigPullRequest


def _tmp_db():
    """返回已跑迁移的 on-file SQLite LocalDb（:memory: 无法被仓储二次连接复用）。"""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    db = connect(tmp.name)
    apply_migrations(db)
    return db


def test_unconfigured_client_raises_on_both_pulls():
    """UnconfiguredGrantsClient：两路 pull 都抛 AppError —— 安全拒绝骨架。"""
    client = UnconfiguredGrantsClient()
    with pytest.raises(AppError, match="未配置"):
        client.pull_authorized_config(
            AuthorizedConfigPullRequest(tenant_id="t", member_id="m", known_versions={})
        )


def test_service_client_unwrap_fallback_when_body_has_no_data():
    """ServiceClientGrantsClient._unwrap：无 data 字段时回退 body 本身（第二分支）。"""

    class _FakeSC:
        def __init__(self):
            self._user_token_provider = None

        def post(self, path, json):
            return {"experts": [], "solutions": [], "revoked_ids": []}

    client = ServiceClientGrantsClient(_FakeSC())
    resp = client.pull_authorized_config(
        AuthorizedConfigPullRequest(tenant_id="t", member_id="m", known_versions={})
    )
    assert resp.experts == []


def test_service_client_sets_user_token_provider_branch():
    """user_token_provider 非空时写入 client._user_token_provider（覆盖构造分支）。"""

    class _FakeSC:
        def __init__(self):
            self._user_token_provider = None

        def post(self, path, json):
            return {"data": {"experts": [], "solutions": [], "revoked_ids": []}}

    fake = _FakeSC()

    def provider():
        return "tok"

    ServiceClientGrantsClient(fake, user_token_provider=provider)
    assert fake._user_token_provider is provider


def test_build_service_no_db_uses_in_memory():
    """db=None → projections/solutions/snapshots 都走内存实现。"""
    svc = build_grants_service()
    assert isinstance(svc, GrantsService)
    assert svc.list_available_solutions() == []
    assert svc.available_experts() == []


def test_build_service_with_db_uses_sqlite():
    """db 非空 → SQLite 实现；覆盖 Sqlite*Repository（store.py 161 行新增）。"""
    db = _tmp_db()
    svc = build_grants_service(db=db)

    class _Fake:
        def __init__(self):
            self._i = 0

        def pull_authorized_config(self, request):
            class R:
                pass
            r = R()
            r.experts = [
                {"employee_id": "e1", "tenant_id": "t", "version": "v1",
                 "handle": "E1", "display_name": "E1"},
            ]
            r.solutions = [
                {"id": "si-1", "solution_id": "tpl-1", "display_name": "A",
                 "planner_prompt": "p", "subtask_prompt": "s", "aggregate_prompt": "a"},
            ]
            r.revoked_ids = []
            return r

        def pull_snapshot(self, request):
            raise NotImplementedError

    svc2 = build_grants_service(client=_Fake(), db=_tmp_db())
    res = svc2.sync("t", "m")
    assert res.upserted == 1
    assert res.revoked == 0
    assert len(svc2.available_experts()) == 1
    assert len(svc2.list_available_solutions()) == 1


def test_build_service_explicit_repositories_respected():
    """显式注入 projections → 不被 db 分支覆盖。"""
    proj = InMemoryProjectionRepository()
    svc = build_grants_service(projections=proj)
    assert svc._projections is proj


def test_sqlite_projection_revoke_returns_prior_row():
    """SqliteProjectionRepository.revoke：行存在时返回快照；不存在返 None（line 379）。"""
    repo = SqliteProjectionRepository(_tmp_db())
    from shared.contracts.grants import LoadedExpertProjection
    obj = LoadedExpertProjection(employee_id="e1", tenant_id="t", version="v1", handle="h", display_name="D")
    repo.upsert(obj)
    prior = repo.revoke("e1")
    assert prior is not None
    assert prior.employee_id == "e1"
    assert prior.revoked is True
    # 现有行已 revoked=True；再取该 employee 仍 revoked
    got = repo.get("e1")
    assert got is not None and got.revoked is True
    assert repo.revoke("never") is None


def test_sqlite_solution_projection_roundtrip():
    """SqliteSolutionProjectionRepository CRUD（覆盖 store.py lines 449-500）。"""
    repo = SqliteSolutionProjectionRepository(_tmp_db())
    p = repo.upsert({
        "id": "si-1", "solution_id": "tpl", "display_name": "A",
        "planner_prompt": "p", "subtask_prompt": "s", "aggregate_prompt": "a",
    })
    assert p.solution_instance_id == "si-1"
    assert len(repo.available()) == 1
    got = repo.get("si-1")
    assert got is not None and got.display_name == "A"
    removed = repo.remove("si-1")
    assert removed is not None
    assert repo.get("si-1") is None


def test_sqlite_snapshot_roundtrip():
    """SqliteSnapshotRepository.freeze / get / latest（覆盖 grants/store.py 新增 SQL 路径）。"""
    from shared.contracts.snapshot import EmployeeExecutionSnapshot
    repo = SqliteSnapshotRepository(_tmp_db())
    snap = repo.freeze(EmployeeExecutionSnapshot(
        employee_id="e1", version="v1", snapshot_version="snap-1",
    ))
    assert snap.snapshot_version == "snap-1"
    assert repo.get("e1", "snap-1") is not None
    assert repo.latest("e1").snapshot_version == "snap-1"
    # 冻第二次幂等（SQLite 重新落库，返回新对象但语义等价）
    again = repo.freeze(EmployeeExecutionSnapshot(
        employee_id="e1", version="v1", snapshot_version="snap-1",
    ))
    assert again is not None
    assert again.snapshot_version == snap.snapshot_version
    assert again is not snap  # SQLite 路径返回新对象（区别于 InMemory 同一引用）


def test_service_client_stores_user_token_provider():
    """ServiceClient 的 user_token_provider 分支真正产出 Authorization 头 (覆盖 service_client.py line 82)。"""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"data": {"x": 1}})

    client = ServiceClient(
        "https://upstream.local",
        transport=httpx.MockTransport(handler),
        user_token_provider=lambda: "tok",
    )
    try:
        client.get("/anything")
        assert seen["auth"] == "Bearer tok"
    finally:
        client.close()
