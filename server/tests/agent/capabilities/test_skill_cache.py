"""M2 SkillCache 验收（AITEAM-691 #2/#4）。"""

from __future__ import annotations

import pytest

from agent_service.capabilities.skill_cache import SkillCache, StoreResult
from shared.contracts.skill import SkillFile, SkillPackage, normalize_skill_file_path


def _pkg(skill_id="code-review", version="1", body="# CR helper", ref="ref.md", ref_body="x") -> SkillPackage:
    return SkillPackage(
        skill_id=skill_id, version=version,
        content_hash="", display_name="Code Review", description="帮助做 code review",
        files=[
            SkillFile(path="SKILL.md", content=body, content_hash="h1"),
            SkillFile(path=f"references/{ref}", content=ref_body, content_hash="h2"),
        ],
    ).with_computed_hash()


def test_store_added_get_kept_updated(tmp_path):
    cache = SkillCache(cache_root=tmp_path)

    assert not cache.exists("code-review", "1")

    r1 = cache.store(_pkg())
    assert r1.status == "added"
    assert cache.exists("code-review", "1")

    pkg = cache.get("code-review", "1")
    assert pkg is not None
    assert pkg.skill_id == "code-review"
    assert {f.path for f in pkg.files} == {"SKILL.md", "references/ref.md"}
    # 读回文件内容一致
    assert [f.content for f in pkg.files if f.path == "SKILL.md"][0] == "# CR helper"

    # 同包再 store —— 应 kept（幂等）
    r2 = cache.store(_pkg())
    assert r2.status == "kept"

    # 改内容 → 真更新
    r3 = cache.store(_pkg(body="# new content").with_computed_hash())
    assert r3.status == "updated"
    assert [f.content for f in cache.get("code-review", "1").files if f.path == "SKILL.md"][0] == "# new content"


def test_list_cached_and_skill_ids(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    assert cache.list_cached() == []
    assert cache.list_skill_ids() == []

    cache.store(_pkg(skill_id="a", version="1", body="A1").with_computed_hash())
    cache.store(_pkg(skill_id="a", version="2", body="A2").with_computed_hash())
    cache.store(_pkg(skill_id="b", version="1", body="B1").with_computed_hash())

    ids = cache.list_skill_ids()
    assert ids == ["a", "b"]
    # list_cached 每个 (skill_id, version) 一条 → 3 条
    items = cache.list_cached()
    assert {(p.skill_id, p.version) for p in items} == {("a", "1"), ("a", "2"), ("b", "1")}


def test_get_latest_highest_version_sorted(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    cache.store(_pkg(version="1", body="1").with_computed_hash())
    cache.store(_pkg(version="2", body="2").with_computed_hash())
    cache.store(_pkg(version="10", body="10").with_computed_hash())
    latest = cache.get_latest("code-review")
    # 字典序末位 "2" < "10"？实际排序：["1","10","2"]，末位="2"
    assert latest is not None
    assert latest.version == "2"


def test_remove_single_version_vs_whole_skill(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    cache.store(_pkg(version="1").with_computed_hash())
    cache.store(_pkg(version="2").with_computed_hash())

    assert cache.remove("code-review", version="1") is True
    assert not cache.exists("code-review", "1")
    assert cache.exists("code-review", "2")

    assert cache.remove("code-review", version="2") is True
    assert not cache.exists("code-review", "2")

    cache.store(_pkg(version="1").with_computed_hash())
    cache.store(_pkg(version="2").with_computed_hash())
    # 不加 version → 删整个 skill_id
    assert cache.remove("code-review") is True
    assert cache.list_skill_ids() == []


def test_path_raises_on_traversal():
    with pytest.raises(ValueError):
        normalize_skill_file_path("../etc/passwd")
    with pytest.raises(ValueError):
        normalize_skill_file_path("/abs/evil")
    with pytest.raises(ValueError):
        normalize_skill_file_path("foo/../../bar")


def test_cache_rejects_unsafe_skill_id(tmp_path):
    cache = SkillCache(cache_root=tmp_path)
    bad = _pkg(skill_id="../evil", version="1")
    with pytest.raises(ValueError):
        cache.store(bad.with_computed_hash())


def test_cache_isolation_between_caches(tmp_path):
    a_root = tmp_path / "a"
    b_root = tmp_path / "b"
    ca = SkillCache(cache_root=a_root)
    cb = SkillCache(cache_root=b_root)
    ca.store(_pkg().with_computed_hash())
    assert ca.exists("code-review", "1")
    assert not cb.exists("code-review", "1")
