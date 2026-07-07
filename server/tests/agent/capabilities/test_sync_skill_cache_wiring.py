"""M2 验收：GrantsService.sync 后技能缓存出现/更新/撤销清理（AITEAM-691 #4）。"""

from __future__ import annotations

import pytest

from agent_service.capabilities.skill_cache import SkillCache
from agent_service.grants.factory import build_grants_service
from shared.contracts.crosstier import AuthorizedConfigPullResponse, SnapshotPullRequest, SnapshotPullResponse
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy
from shared.contracts.skill import SkillFile, SkillPackage


def _snapshot(employee_id="emp-1", version="v1", snap="snap-1", skills=("sr",)):
    return EmployeeExecutionSnapshot(
        employee_id=employee_id, version=version, snapshot_version=snap,
        skills=list(skills), display_name=employee_id,
        model_policy=ModelPolicy(), runtime_policy=RuntimePolicy(),
    )


def _skillpkg(skill_id="sr", version="1", body="# sr helper"):
    return SkillPackage(
        skill_id=skill_id, version=version, content_hash="",
        display_name=skill_id, description="",
        files=[SkillFile(path="SKILL.md", content=body, content_hash="h")],
    ).with_computed_hash()


class FakeClient:
    def __init__(self, experts_revoked=False, with_skill_packages=True):
        self.experts_revoked = experts_revoked
        self.with_skill_packages = with_skill_packages

    def pull_authorized_config(self, request):
        from shared.contracts.crosstier import AuthorizedConfigPullRequest
        if self.experts_revoked:
            return AuthorizedConfigPullResponse(
                experts=[], solutions=[],
                revoked_ids=["emp-1"],  # 撤销专家 → 其技能应清理
                skill_packages=[],
            )
        emp = {
            "employee_id": "emp-1", "version": "v1", "display_name": "E1",
            "skills": ["sr"], "runtime_binding": "codex",
            "persona": "", "model_policy": {}, "runtime_policy": {}, "tools": [],
            "knowledge_refs": [], "connector_refs": [], "memory_policy": None,
        }
        pkgs = [_skillpkg().model_dump(mode="json")] if self.with_skill_packages else []
        return AuthorizedConfigPullResponse(
            experts=[emp], solutions=[], revoked_ids=[],
            skill_packages=pkgs,
        )

    def pull_snapshot(self, request):
        from shared.contracts.crosstier import SnapshotPullRequest, SnapshotPullResponse
        s = _snapshot()
        return SnapshotPullResponse(snapshot=s)


def test_sync_writes_skill_cache_when_provided_by_manager(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    svc = build_grants_service(skill_cache=cache)
    # 注入“可到达 Manager”的对端
    svc._client = FakeClient()
    res = svc.sync("local", "m1")
    assert res.ok
    assert res.skill_stored == 1
    assert cache.exists("sr", "1")
    assert (cache.package_dir("sr", "1") / "SKILL.md").read_text() == "# sr helper"


def test_sync_removes_cache_after_revocation(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_skillpkg().with_computed_hash())
    assert cache.exists("sr", "1")

    svc = build_grants_service(skill_cache=cache)
    svc._client = FakeClient(experts_revoked=True)
    res = svc.sync("local", "m1")
    assert res.ok
    assert res.skill_revoked_removed == 1
    assert not cache.exists("sr", "1")


def test_sync_degrades_on_unreachable_manager(tmp_path):
    """Manager 不可达 → ok=False，不影响本地缓存/D14。"""
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_skillpkg().with_computed_hash())
    svc = build_grants_service(skill_cache=cache)

    class U:
        def pull_authorized_config(self, request):
            raise RuntimeError("manager unreachable")
        def pull_snapshot(self, request):
            from shared.contracts.crosstier import SnapshotPullResponse
            return SnapshotPullResponse(snapshot=_snapshot())

    svc._client = U()
    res = svc.sync("local", "m1")
    assert not res.ok
    # 本地缓存不受断网影响
    assert cache.exists("sr", "1")


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
