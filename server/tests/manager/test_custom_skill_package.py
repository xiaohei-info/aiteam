"""S05 custom package input validation, including legacy invalid rows."""
from types import SimpleNamespace as NS

import pytest

from manager_service.custom_skill_package import catalog_package, package_status, validate_custom_package
from shared.errors import ValidationProblem


@pytest.mark.parametrize("header", ["description: Useful skill", "description: 'Quoted skill'", 'description: "Quoted skill"', "description: |\n  Multi line\n  description", "description: >\n  Folded\n  description", "description: CRLF\r\nname: fixture"])
def test_custom_skill_frontmatter_matches_supported_pi_subset(header):
    files = [{"path": "SKILL.md", "content": f"---\n{header}\n---\nFollow the fixture instructions."}]
    package = validate_custom_package(skill_id="fixture", version="v1", files=files)
    assert package.content_hash == package.compute_content_hash()
    assert package_status(NS(skill_id="fixture", version="v1", files=files, content_hash=package.content_hash)) == "ready"


@pytest.mark.parametrize("content", [
    "# Missing frontmatter", "---\nname: fixture\n---\nbody", "---\ndescription: false\n---\nbody",
    "---\ndescription: [list]\n---\nbody", "---\ndescription: {nested: x}\n---\nbody",
    "---\ndescription: yes\n---\nbody",  # YAML1.1/1.2 ambiguity is deliberately rejected
    "---\ndescription: [broken\n---\nbody", "---\ndescription: ''\n---\nbody",
    "---\ndescription: okay\nname: 123\n---\nbody", "---\ndescription: one\ndescription: two\n---\nbody",
    "---\nx: &anchor text\ndescription: *anchor\n---\nbody", "---\ndescription: okay\n<<: {name: x}\n---\nbody",
    "---\ndescription: okay\nx: " + "[" * 100 + "0" + "]" * 100 + "\n---\nbody",
    "---\ndescription: " + "x" * 9000 + "\n---\nbody",
])
def test_invalid_frontmatter_cannot_be_uploaded_or_claim_ready(content):
    files = [{"path": "SKILL.md", "content": content}]
    with pytest.raises(ValidationProblem) as error:
        validate_custom_package(skill_id="fixture", version="1", files=files)
    assert content not in str(error.value)
    assert package_status(NS(skill_id="fixture", version="1", files=files, content_hash="0" * 16)) == "invalid"


@pytest.mark.parametrize("files", [[], [{"path": "../SKILL.md", "content": "x"}], [{"path": "script.sh", "content": "x"}], [{"path": "SKILL.md", "content": "x"}] * 65, [{"path": "SKILL.md", "content": "x" * (1024 * 1024 + 1)}]])
def test_custom_package_rejects_empty_unsafe_and_oversized(files):
    with pytest.raises(ValidationProblem):
        validate_custom_package(skill_id="fixture", version="1", files=files)


@pytest.mark.parametrize("files", ["legacy scalar", 7, True, {"legacy": True}, []])
def test_non_array_legacy_files_are_invalid_without_fabricated_entries(files):
    from manager_service.capability_catalog_repository import SkillCatalogRow
    from manager_service.capability_catalog_service import _skill_to_out
    row = SkillCatalogRow(catalog_id="fixture", skill_id="legacy", display_name="Legacy", version="1",
        install_policy="on_demand", binding_policy="opt_in", visibility="tenant", config={}, files=files,
        content_hash="", catalog_version=1)
    out = _skill_to_out(row)
    if files == []:
        assert out.package_status == "draft"
    else:
        assert out.package_status == "invalid" and out.files == files
        from manager_service.authorized_config_service import _catalog_row_to_out
        projected = _catalog_row_to_out(row)
        assert projected.package_status == "invalid" and projected.files == files


def test_fileless_catalog_is_draft_and_stored_wrong_hash_is_invalid():
    assert package_status(NS(files=[], content_hash="")) == "draft"
    files = [{"path": "SKILL.md", "content": "---\ndescription: okay\n---\nbody"}]
    with pytest.raises(ValidationProblem):
        validate_custom_package(skill_id="fixture", version="1", files=files, content_hash="0" * 16)
    assert package_status(NS(skill_id="fixture", version="1", files=files, content_hash="")) == "invalid"


def test_migration0039_guards_jsonb_array_length_for_legacy_scalars_and_objects():
    from pathlib import Path
    sql = (Path(__file__).parents[2] / "manager_service/migrations/0039_knowledge_job_recovery.sql").read_text()
    assert "jsonb_typeof(files) = 'array'" in sql
    assert "jsonb_array_length(" in sql
    assert "ELSE '[]'::jsonb" in sql
    assert "CASE" in sql and "ELSE false" in sql
    assert "DELETE FROM skill_catalog" not in sql


def test_legacy_oversized_invalid_row_can_be_inspected_without_rewriting_files():
    from manager_service.capability_catalog_repository import SkillCatalogRow
    from manager_service.capability_catalog_service import _skill_to_out
    files = [{"path": "SKILL.md", "content": "# legacy"}] * 65
    out = _skill_to_out(SkillCatalogRow(catalog_id="fixture", skill_id="legacy", display_name="Legacy", version="1",
        install_policy="on_demand", binding_policy="opt_in", visibility="tenant", config={}, files=files, content_hash="", catalog_version=1))
    assert out.package_status == "invalid" and len(out.files) == 65
