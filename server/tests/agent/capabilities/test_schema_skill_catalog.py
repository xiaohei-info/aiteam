"""M2 验收：Manager SkillCatalogIn/Out 新增 files/content_hash 字段透传。"""

from __future__ import annotations

import pytest

from manager_service.schemas import SkillCatalogIn, SkillCatalogOut, SkillFileIn


def test_skill_file_in_schema():
    f = SkillFileIn(path="SKILL.md", content="# x")
    assert f.path == "SKILL.md"


def test_skill_catalog_in_with_files():
    files = [SkillFileIn(path="SKILL.md", content="# hi"), SkillFileIn(path="references/a.md", content="r")]
    body = SkillCatalogIn(skill_id="sr", version="2", files=files, content_hash="deadbeef")
    assert [fi.path for fi in body.files] == ["SKILL.md", "references/a.md"]
    assert body.content_hash == "deadbeef"


def test_skill_catalog_in_defaults():
    """backward-compat：不加 files 也不报错。"""
    body = SkillCatalogIn(skill_id="sr")
    assert body.files == []
    assert body.content_hash == ""


def test_skill_catalog_out_roundtrip():
    body = SkillCatalogOut(
        catalog_id="abc", skill_id="sr", version="2",
        files=[SkillFileIn(path="SKILL.md", content="# x")], content_hash="h",
        catalog_version=3,
    )
    assert body.catalog_id == "abc"
    assert body.catalog_version == 3
    assert body.files[0].path == "SKILL.md"


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
