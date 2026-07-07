"""M2 SkillProjector 验收（AITEAM-691 #3/#5）。"""

from __future__ import annotations

import pytest

from agent_service.capabilities.skill_cache import SkillCache
from agent_service.capabilities.skill_projector import (
    RUNTIME_SKILL_DIR,
    _openclaw_dir,
    _codex_dirs,
    MissingSkillError,
    SkillProjector,
    project_skills,
)
from shared.contracts.skill import SkillFile, SkillPackage


def _pkg(skill_id="code-review", version="1", body="# CR helper") -> SkillPackage:
    return SkillPackage(
        skill_id=skill_id, version=version, content_hash="",
        display_name="Code Review", description="",
        files=[SkillFile(path="SKILL.md", content=body, content_hash="h")],
    ).with_computed_hash()


def test_directory_mapping_per_runtime(tmp_path):
    # 校验每个 M2 目录构造符合规范。
    ref = tmp_path / "run123"
    assert _openclaw_dir(ref, "code-review") == ref / "skills" / "code-review"
    assert _codex_dirs(ref, "code-review") == ref / "codex-home" / "skills" / "code-review"
    assert RUNTIME_SKILL_DIR["hermes"](ref, "x") == ref / ".agent_context" / "skills" / "x"
    assert RUNTIME_SKILL_DIR["claude_code"](ref, "x") == ref / ".claude" / "skills" / "x"
    assert RUNTIME_SKILL_DIR["opencode"](ref, "x") == ref / ".opencode" / "skills" / "x"


def test_project_writes_native_dir_structure(tmp_path):
    cache_root = tmp_path / "cache"
    work_root = tmp_path / "run_work"
    work_root.mkdir()

    SkillCache(cache_root).store(_pkg().with_computed_hash())
    proj = SkillProjector(SkillCache(cache_root))

    # claude_code runtime：workDir/.claude/skills/{name}/SKILL.md
    out = proj.project(run_id="run-1", work_dir=work_root, runtime="claude_code",
                       skill_refs=["code-review"])
    assert out.ok
    target = work_root / ".claude" / "skills" / "code-review"
    assert (target / "SKILL.md").is_file()
    assert (target / "SKILL.md").read_text() == "# CR helper"

    # codex runtime：workDir/codex-home/skills/{name}/SKILL.md + env CODEX_HOME
    work_root2 = tmp_path / "run_work2"; work_root2.mkdir()
    out2 = proj.project(run_id="run-2", work_dir=work_root2, runtime="codex",
                        skill_refs=["code-review"])
    assert out2.ok
    target2 = work_root2 / "codex-home" / "skills" / "code-review"
    assert (target2 / "SKILL.md").is_file()
    assert out2.env_overrides["CODEX_HOME"] == str((work_root2 / "codex-home").resolve())


def test_missing_skill_raises_when_required(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_pkg().with_computed_hash())
    proj = SkillProjector(cache)
    work = tmp_path / "w"; work.mkdir()

    with pytest.raises(MissingSkillError) as excinfo:
        proj.project(run_id="run", work_dir=work, runtime="claude_code",
                     skill_refs=["code-review", "not-installed"])
    # 缺失清单可控
    assert "not-installed" in excinfo.value.missing
    assert "code-review" not in excinfo.value.missing
    # 缺失时也声明 runtime（便于前端展示）
    assert excinfo.value.runtime == "claude_code"


def test_fail_on_missing_false_partial_results(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_pkg().with_computed_hash())
    proj = SkillProjector(cache)
    work = tmp_path / "w"; work.mkdir()
    out = proj.project(run_id="r", work_dir=work, runtime="openclaw",
                       skill_refs=["code-review", "missing-tool"], fail_on_missing=False)
    assert not out.ok
    assert out.missing == ["missing-tool"]
    assert len(out.projected) == 1


def test_project_does_not_touch_runtime_shared_profile(tmp_path):
    """投影只落在 workDir 内，绝不刺探 workDir 之外的文件。"""
    import os
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_pkg().with_computed_hash())
    work = tmp_path / "w"; work.mkdir()
    sibling = tmp_path / "SOUL.md"; sibling.write_text("sensitive")
    proj = SkillProjector(cache)
    proj.project(run_id="r", work_dir=work, runtime="codex", skill_refs=["code-review"])
    # 工作目录外没有任何文件被碰
    assert sibling.read_text() == "sensitive"
    # 不再引用 codex-home 非 workDir 之外
    assert not (tmp_path / "codex-home").exists()


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
