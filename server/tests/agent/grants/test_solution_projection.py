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
                {
                    "solution_id": "sol-1",
                    "version": "v2",
                    "display_name": "电商专家群",
                    "planner_prompt": "planner A",
                    "subtask_prompt": "subtask A",
                    "aggregate_prompt": "aggregate A",
                },
                {
                    "solution_id": "sol-2",
                    "version": "v1",
                    "display_name": "客服应答群",
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
    assert items[0]["solution_instance_id"] == "sol-1"  # sorted by id
    assert items[0]["display_name"] == "电商专家群"
    assert items[0]["planner_prompt"] == "planner A"


def test_list_available_solutions_without_store_returns_empty():
    svc = _service(with_solutions=False)
    svc.sync("t1", "m1")
    assert svc.list_available_solutions() == []


def test_solution_projection_to_dict_fields():
    p = SolutionProjection(
        solution_id="sol-x",
        display_name="X",
        planner_prompt="p",
        subtask_prompt="s",
        aggregate_prompt="a",
    )
    d = p.to_dict()
    assert d.keys() == {"solution_instance_id", "display_name", "version", "planner_prompt", "subtask_prompt", "aggregate_prompt"}
    assert d["solution_instance_id"] == "sol-x"
    assert d["display_name"] == "X"


def test_in_memory_repo_remove_and_available():
    repo = InMemorySolutionProjectionRepository()
    repo.upsert({"solution_id": "a", "display_name": "A", "planner_prompt": "p"})
    repo.upsert({"solution_id": "b", "display_name": "B", "planner_prompt": "q"})
    assert len(repo.available()) == 2
    repo.remove("a")
    assert len(repo.available()) == 1
    assert repo.get("a") is None
    assert repo.get("b") is not None
