from shared.contracts.platform_skill import PlatformSkillPackage, PlatformSkillRef
from shared.contracts.skill import SkillFile, SkillPackage, derive_file_hash
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

from manager_service.capability_catalog_repository import SkillCatalogRow
from manager_service.operator_catalog import FakeOperatorCatalogClient
from manager_service.platform_skill_service import PlatformSkillService


class FakeCatalog:
    def __init__(self):
        self.rows = {}

    def list_skills(self, ctx):
        return list(self.rows.values())

    def get_skill_by_id(self, ctx, *, skill_id):
        return self.rows.get(skill_id)

    def create_skill(self, ctx, **kw):
        row = SkillCatalogRow(
            catalog_id="cat-1", skill_id=kw["skill_id"], display_name=kw["display_name"],
            version=kw["version"], install_policy=kw["install_policy"], binding_policy=kw["binding_policy"],
            visibility=kw["visibility"], config=kw["config"], files=kw["files"],
            content_hash=kw["content_hash"], catalog_version=1,
        )
        self.rows[row.skill_id] = row
        return row

    def update_skill(self, ctx, *, catalog_id, **kw):
        old = next(row for row in self.rows.values() if row.catalog_id == catalog_id)
        row = SkillCatalogRow(catalog_id=catalog_id, skill_id=old.skill_id, catalog_version=old.catalog_version + 1, **kw)
        self.rows[row.skill_id] = row
        return row


def _package(skill_id="skill-1", version="1.0.0", content="# Skill"):
    package = SkillPackage(
        skill_id=skill_id,
        version=version,
        content_hash="",
        display_name="Skill One",
        files=[SkillFile(path="SKILL.md", content=content, content_hash=derive_file_hash(content))],
    ).with_computed_hash()
    return PlatformSkillPackage(owner="publisher", slug="skill-one", package=package)


def _ctx():
    return TenantContext(tenant_id="tenant-1", user_id="owner-1", roles=["owner"])


def test_install_pinned_operator_skill_into_tenant_catalog():
    operator = FakeOperatorCatalogClient()
    remote = _package()
    operator.seed_platform_skill(remote)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    ref = PlatformSkillRef(skill_id=remote.package.skill_id, version=remote.package.version, content_hash=remote.package.content_hash)

    first = service.install(_ctx(), ref)
    second = service.install(_ctx(), ref)

    tenant_skill_id = f"platform-{ref.skill_id}-{ref.version}-{ref.content_hash[:16]}"
    assert first.installed is True
    assert first.skill_id == tenant_skill_id
    assert second.installed is False
    assert catalog.rows[tenant_skill_id].files == [{"path": "SKILL.md", "content": "# Skill"}]


def test_two_versions_keep_distinct_tenant_skill_ids():
    operator = FakeOperatorCatalogClient()
    first = _package(version="1.0.0", content="# V1")
    second = _package(version="2.0.0", content="# V2")
    operator.seed_platform_skill(first)
    operator.seed_platform_skill(second)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    first_ref = PlatformSkillRef(skill_id=first.package.skill_id, version=first.package.version, content_hash=first.package.content_hash)
    second_ref = PlatformSkillRef(skill_id=second.package.skill_id, version=second.package.version, content_hash=second.package.content_hash)

    first_id = service.install(_ctx(), first_ref).skill_id
    second_id = service.install(_ctx(), second_ref).skill_id

    assert first_id != second_id
    assert catalog.rows[first_id].files[0]["content"] == "# V1"
    assert catalog.rows[second_id].files[0]["content"] == "# V2"


def test_market_state_is_current_when_any_installed_version_matches():
    operator = FakeOperatorCatalogClient()
    v1 = _package(version="1.0.0", content="# V1")
    v2 = _package(version="2.0.0", content="# V2")
    operator.seed_platform_skill(v1)
    operator.seed_platform_skill(v2)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    ref2 = PlatformSkillRef(skill_id=v2.package.skill_id, version=v2.package.version, content_hash=v2.package.content_hash)
    ref1 = PlatformSkillRef(skill_id=v1.package.skill_id, version=v1.package.version, content_hash=v1.package.content_hash)
    service.install(_ctx(), ref2)
    service.install(_ctx(), ref1)

    market = service.list_market(_ctx())[0]

    assert market["installed_versions"] == ["1.0.0", "2.0.0"]
    assert market["update_available"] is False


def test_market_projection_discards_operator_bookkeeping_fields():
    class Operator:
        def list_platform_skills(self):
            return [{
                "skill_id": "skill-1", "owner": "publisher", "slug": "skill-one",
                "display_name": "Skill One", "summary": "summary",
                "published_version": "1.0.0", "content_hash": "hash", "status": "published",
                "latest_external_version": "1.0.1", "latest_internal_version": "1.0.1",
                "latest_content_hash": "other", "latest_version_status": "published",
                "version_id": None, "version": None,
            }]

    market = PlatformSkillService(operator=Operator(), catalog=FakeCatalog()).list_market(_ctx())[0]
    assert market == {
        "skill_id": "skill-1", "display_name": "Skill One", "summary": "summary",
        "owner": "publisher", "slug": "skill-one", "published_version": "1.0.0",
        "content_hash": "hash", "installed": False, "installed_version": None,
        "installed_content_hash": None, "installed_versions": [], "update_available": False,
    }


def test_install_rejects_mismatched_hash():
    operator = FakeOperatorCatalogClient()
    remote = _package()
    operator.seed_platform_skill(remote)
    service = PlatformSkillService(operator=operator, catalog=FakeCatalog())
    bad = PlatformSkillRef(skill_id=remote.package.skill_id, version=remote.package.version, content_hash="wrong")

    try:
        service.install(_ctx(), bad)
    except Conflict as exc:
        assert "does not match" in str(exc)
    else:
        raise AssertionError("expected conflict")
