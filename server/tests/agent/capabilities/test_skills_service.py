"""M2 SkillsService 验收（AITEAM-691 #4：sync 缓存 + revoke 清理）。"""

from __future__ import annotations

from agent_service.capabilities.skill_cache import SkillCache
from agent_service.capabilities.skills_service import SkillsService, SyncResult
from shared.contracts.skill import SkillFile, SkillPackage


def _pkg(skill_id="sr", version="1", body="# x") -> SkillPackage:
    return SkillPackage(
        skill_id=skill_id, version=version, content_hash="",
        display_name=skill_id, description="",
        files=[SkillFile(path="SKILL.md", content=body, content_hash="h")],
    ).with_computed_hash()


def test_store_from_sync_counters_added(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    svc = SkillsService(cache)
    pkgs = [_pkg(skill_id="a", version="1"), _pkg(skill_id="b", version="1")]
    res = svc.store_from_sync([p.model_dump(mode="json") for p in pkgs])
    # store_from_sync 接受 dict：解释后全部 added
    assert res.stored == 2
    assert cache.list_skill_ids() == ["a", "b"]

    # 重复 store → kept
    res2 = svc.store_from_sync([p.model_dump(mode="json") for p in pkgs])
    assert res2.kept == 2 and res2.stored == 0


def test_apply_revocation_removes_skills(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    svc = SkillsService(cache)
    cache.store(_pkg(skill_id="keep").with_computed_hash())
    cache.store(_pkg(skill_id="drop").with_computed_hash())
    assert sorted(cache.list_skill_ids()) == ["drop", "keep"]

    removed = svc.apply_revocation(["drop"])
    assert removed == 1
    assert cache.list_skill_ids() == ["keep"]


def test_clear_all(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    svc = SkillsService(cache)
    cache.store(_pkg(skill_id="a").with_computed_hash())
    cache.store(_pkg(skill_id="b").with_computed_hash())
    assert svc.clear_all() == 2
    assert cache.list_skill_ids() == []


def test_package_coercion_handles_skillpackage_instance(tmp_path):
    """store_packages 既能接受 SkillPackage 也能接受 dict。"""
    cache = SkillCache(cache_root=tmp_path)
    svc = SkillsService(cache)
    res = svc.store_packages([_pkg(skill_id="x", version="9").model_dump(mode="json"),
                              _pkg(skill_id="y", version="1")])
    assert res.stored == 2
    assert sorted(cache.list_skill_ids()) == ["x", "y"]


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
