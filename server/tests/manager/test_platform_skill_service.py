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

    def replace_platform_package(self, ctx, *, catalog_id, display_name, version, config, files, content_hash):
        old = next(row for row in self.rows.values() if row.catalog_id == catalog_id)
        if old.config.get("source") != "operator":
            return None
        row = SkillCatalogRow(
            catalog_id=catalog_id, skill_id=old.skill_id, display_name=display_name, version=version,
            install_policy=old.install_policy, binding_policy=old.binding_policy, visibility=old.visibility,
            config=config, files=files, content_hash=content_hash, catalog_version=old.catalog_version + 1,
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

    tenant_skill_id = f"platform-{ref.skill_id}"
    assert first.installed is True
    assert first.skill_id == tenant_skill_id
    assert second.installed is False
    row = catalog.rows[tenant_skill_id]
    assert row.files == [{"path": "SKILL.md", "content": "# Skill"}]
    # Display fields (design「技能MCP命名空间出处与更新提示」§4.1): owner/slug of a ClawHub skill → 来自 ClawHub.
    assert row.config["namespace"] == "" and row.config["provenance"]["label"] == "ClawHub publisher/skill-one"


def test_prepared_install_never_fetches_remote_package_inside_write_step():
    operator = FakeOperatorCatalogClient()
    remote = _package()
    operator.seed_platform_skill(remote)
    calls = []
    original = operator.pull_platform_skill
    def pull_platform_skill(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)
    operator.pull_platform_skill = pull_platform_skill
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    ref = PlatformSkillRef(skill_id=remote.package.skill_id, version=remote.package.version, content_hash=remote.package.content_hash)

    prepared = service.prepare(_ctx(), ref)
    assert len(calls) == 1
    assert service.install_prepared(_ctx(), prepared).installed is True
    assert len(calls) == 1


def _ref(remote):
    return PlatformSkillRef(skill_id=remote.package.skill_id, version=remote.package.version, content_hash=remote.package.content_hash)


def test_update_replaces_the_one_row_in_place_keeping_id_and_switches():
    operator = FakeOperatorCatalogClient()
    first = _package(version="1.0.0", content="# V1")
    second = _package(version="2.0.0", content="# V2")
    operator.seed_platform_skill(first)
    operator.seed_platform_skill(second)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)

    first_id = service.install(_ctx(), _ref(first)).skill_id
    old = catalog.rows[first_id]
    catalog.rows[first_id] = SkillCatalogRow(**{**old.__dict__, "visibility": "private", "binding_policy": "disabled"})
    updated = service.install(_ctx(), _ref(second))

    assert updated.skill_id == first_id and updated.installed is True
    assert list(catalog.rows) == [first_id]
    row = catalog.rows[first_id]
    assert (row.version, row.files[0]["content"], row.config["source_version"]) == ("2.0.0", "# V2", "2.0.0")
    assert (row.visibility, row.binding_policy) == ("private", "disabled")


def test_recruiting_with_another_pinned_version_keeps_what_the_enterprise_has():
    operator = FakeOperatorCatalogClient()
    first = _package(version="1.0.0", content="# V1")
    second = _package(version="2.0.0", content="# V2")
    operator.seed_platform_skill(first)
    operator.seed_platform_skill(second)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    installed_id = service.install(_ctx(), _ref(second)).skill_id

    assert service.install_all(_ctx(), [_ref(first)]) == [installed_id]
    assert catalog.rows[installed_id].version == "2.0.0"


def test_market_shows_update_until_the_row_moves_to_the_published_version():
    operator = FakeOperatorCatalogClient()
    v1 = _package(version="1.0.0", content="# V1")
    operator.seed_platform_skill(v1)
    catalog = FakeCatalog()
    service = PlatformSkillService(operator=operator, catalog=catalog)
    service.install(_ctx(), _ref(v1))
    v2 = _package(version="2.0.0", content="# V2")
    operator.seed_platform_skill(v2)

    market = service.list_market(_ctx())[0]
    assert (market["installed_version"], market["published_version"], market["update_available"]) == ("1.0.0", "2.0.0", True)
    service.install(_ctx(), _ref(v2))
    market = service.list_market(_ctx())[0]
    assert (market["installed_versions"], market["update_available"]) == (["2.0.0"], False)


def test_custom_platform_skill_carries_the_namespace_iofhjksu_lists():
    class Operator(FakeOperatorCatalogClient):
        def list_platform_skills(self):
            return [{**item, "namespace": "taiyim", "provenance": {"kind": "clawhub", "label": "ClawHub a/b", "edited": True, "version": "1.0.0"}}
                    for item in super().list_platform_skills()]

    operator = Operator()
    remote = _package(content="---\nname: skill-one\ndescription: d\n---\n")
    operator.seed_platform_skill(remote)
    catalog = FakeCatalog()
    skill_id = PlatformSkillService(operator=operator, catalog=catalog).install(_ctx(), _ref(remote)).skill_id
    config = catalog.rows[skill_id].config
    assert config["namespace"] == "taiyim" and config["provenance"]["edited"] is True and config["skill_name"] == "skill-one"


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
        "namespace": "", "provenance": {"kind": "clawhub", "label": "ClawHub publisher/skill-one",
                                        "url": "https://clawhub.ai/publisher/skills/skill-one", "version": "", "edited": False},
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
