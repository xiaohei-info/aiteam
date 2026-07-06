"""A4 扩展验收：方案实例投影（SolutionProjection）本地存储 + 服务查询。"""

from __future__ import annotations

from agent_service.grants.service import GrantsService
from agent_service.grants.store import (
    InMemoryProjectionRepository,
    InMemorySnapshotRepository,
    InMemorySolutionProjectionRepository,
    SolutionProjection,
)


def _service(*, with_solutions: bool = True) -> GrantsService:
    return GrantsService(
        client=_FakeClient(),
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
        solutions=InMemorySolutionProjectionRepository() if with_solutions else None,
    )


class _FakeClient:
    def pull_authorized_config(self, request):
        class R:
            experts = []
            solutions = [
                {   # id=instance id, solution_id=Operator template id (different ids → regression check)
                    "id": "si-1",
                    "solution_id": "tpl-1",
                    "version": "v2",
                    "display_name": "电商专家群",
                    "expert_employee_ids": ["emp-1", "emp-2"],
                    "planner_prompt": "planner A",
                    "subtask_prompt": "subtask A",
                    "aggregate_prompt": "aggregate A",
                },
                {
                    "id": "si-2",
                    "solution_id": "tpl-2",
                    "version": "v1",
                    "display_name": "客服应答群",
                    "expert_employee_ids": ["emp-3"],
                    "planner_prompt": "planner B",
                    "subtask_prompt": "subtask B",
                    "aggregate_prompt": "aggregate B",
                },
            ]
            revoked_ids = []

        return R()

    def pull_snapshot(self, request):
        raise NotImplementedError


def test_list_available_solutions_returns_snapshot_dicts():
    svc = _service()
    svc.sync("t1", "m1")
    items = svc.list_available_solutions()
    assert len(items) == 2
    assert items[0]["solution_instance_id"] == "si-1"  # instance id, not template id
    assert items[0]["display_name"] == "电商专家群"
    assert items[0]["expert_employee_ids"] == ["emp-1", "emp-2"]
    # B2 regression: template id must NOT leak as solution_instance_id
    assert items[0]["solution_instance_id"] != "tpl-1"
    assert items[0]["planner_prompt"] == "planner A"


def test_list_available_solutions_without_store_returns_empty():
    svc = _service(with_solutions=False)
    svc.sync("t1", "m1")
    assert svc.list_available_solutions() == []


def test_solution_projection_to_dict_fields():
    p = SolutionProjection(
        solution_instance_id="sol-x",
        template_solution_id="tpl-x",
        display_name="X",
        planner_prompt="p",
        subtask_prompt="s",
        aggregate_prompt="a",
    )
    d = p.to_dict()
    # template_solution_id is intentionally stripped from the API contract
    assert d.keys() == {"solution_instance_id", "display_name", "version", "expert_employee_ids", "planner_prompt", "subtask_prompt", "aggregate_prompt"}
    assert d["solution_instance_id"] == "sol-x"
    assert d["display_name"] == "X"
    # template id is tracked internally but never exposed as the instance id
    assert p.template_solution_id == "tpl-x"


def test_in_memory_repo_remove_and_available():
    repo = InMemorySolutionProjectionRepository()
    repo.upsert({"id": "a", "solution_id": "tpl-a", "display_name": "A", "planner_prompt": "p"})
    repo.upsert({"id": "b", "solution_id": "tpl-b", "display_name": "B", "planner_prompt": "q"})
    assert len(repo.available()) == 2
    repo.remove("a")
    assert len(repo.available()) == 1
    assert repo.get("a") is None
    assert repo.get("b") is not None


class _FakeClientWithRevoke:
    """返回 revoked_ids + 空增量 → 覆盖 sync() 的 revoke 分支（line 156/157）+ upsert 后增量。"""

    def __init__(self, *, with_solutions: bool = True):
        self._with = with_solutions
        self._first = True

    def pull_authorized_config(self, request):
        class R:
            def __init__(self, outer):
                # 第一轮放 experts+solutions，第二轮把它们当 revoked 返回。
                if outer._first:
                    outer._first = False
                    self.experts = [
                        {
                            "employee_id": "e1",
                            "tenant_id": "t1",
                            "version": "v1",
                            "handle": "专家A",
                            "display_name": "专家A",
                        },
                    ]
                    self.solutions = [
                        {"id": "si-1", "solution_id": "tpl-1", "display_name": "群A",
                         "planner_prompt": "p", "subtask_prompt": "s", "aggregate_prompt": "a"},
                        {"display_name": "无ID方案"},
                    ] if outer._with else []
                    self.revoked_ids = []
                else:
                    self.experts = []
                    self.solutions = []
                    self.revoked_ids = ["e1", "si-1"]  # revoke expert + solution

        return R(self)

    def pull_snapshot(self, request):
        raise NotImplementedError


def test_sync_revokes_expert_and_solution_and_then_upsert():
    """覆盖 grants/service.py sync() 的 revoke 分支：expert/solution 被 revoke 后不计入 available。"""
    client = _FakeClientWithRevoke(with_solutions=True)
    svc = GrantsService(
        client=client,
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
        solutions=InMemorySolutionProjectionRepository(),
    )
    first = svc.sync("t1", "m1")
    assert first.ok is True
    assert first.upserted == 1  # 1 expert
    assert first.revoked == 0
    assert len(svc.available_experts()) == 1
    assert len(svc.list_available_solutions()) == 1

    second = svc.sync("t1", "m1")
    assert second.ok is True
    assert second.upserted == 0
    assert second.revoked == 2  # e1(projection)+si-1(solution) 都被 revocation 命中
    assert len(svc.available_experts()) == 0


def test_sync_without_solutions_repo_skips_solution_branches():
    """solutions=None 时 skip 两个 solution 分支（line 157 if + line 161 if）。"""
    client = _FakeClientWithRevoke(with_solutions=False)
    svc = GrantsService(
        client=client,
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
        solutions=None,
    )
    svc.sync("t1", "m1")
    # 第二轮 revoke 只命中 expert 分支；solutions 分支整体跳过
    second = svc.sync("t1", "m1")
    assert second.revoked == 1
    assert svc.list_available_solutions() == []


def test_sync_offline_returns_ok_false():
    """Manager 不可达 → ok=False，已落投影不变（D14 降级）。覆盖 line 144。"""

    class _OfflineClient:
        def pull_authorized_config(self, request):
            raise ConnectionError("manager down")

        def pull_snapshot(self, request):
            raise NotImplementedError

    svc = GrantsService(
        client=_OfflineClient(),
        projections=InMemoryProjectionRepository(),
        snapshots=InMemorySnapshotRepository(),
        solutions=InMemorySolutionProjectionRepository(),
    )
    res = svc.sync("t1", "m1")
    assert res.ok is False
    assert "manager down" in res.error
