"""Real route/service/PG fingerprints and metadata editing; no real skills or keys."""
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from manager_service.capability_catalog_repository import CapabilityCatalogRepository
from manager_service.capability_catalog_service import CapabilityCatalogService
from manager_service.schemas import SkillCatalogIn
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations
from shared.errors import Conflict
from tests.manager.test_capability_catalog_e2e import _client, _token

pytestmark = pytest.mark.integration
FILES = [{"path": "SKILL.md", "content": "---\nname: fixture\ndescription: Synthetic skill\n---\nRead the synthetic document."}]


def test_metadata_put_preserves_signed_package_and_replacement_versions(migrated_db, admin_url, two_tenants):
    client = _client(migrated_db, admin_url)
    headers = {"Authorization": f"Bearer {_token(two_tenants[0], ['owner'], admin_url=admin_url)}"}
    created = client.post("/api/manager/skills", headers=headers, json={"skill_id": "custom-fixture", "version": "v1", "display_name": "original", "files": FILES})
    assert created.status_code == 201, created.text
    original = created.json()["data"]
    assert original["package_status"] == "ready" and len(original["content_hash"]) == 16
    path = f"/api/manager/skills/{original['catalog_id']}"
    renamed = client.put(path, headers=headers, json={"skill_id": "custom-fixture", "display_name": "Renamed"})
    assert renamed.status_code == 200, renamed.text
    for field in ("version", "files", "content_hash", "install_policy", "binding_policy", "visibility"):
        assert renamed.json()["data"][field] == original[field]
    replay = client.put(path, headers=headers, json={"skill_id": "custom-fixture", "version": "v1", "files": FILES})
    assert replay.status_code == 200
    changed = [{**FILES[0], "content": FILES[0]["content"] + "\nChanged."}]
    for body in ({"files": []}, {"files": changed, "version": "v1"}, {"files": FILES, "content_hash": "bad"}):
        rejected = client.put(path, headers=headers, json={"skill_id": "custom-fixture", **body})
        assert rejected.status_code in (409, 422), rejected.text
    assert client.put(path, headers=headers, json={"skill_id": "custom-fixture", "version": "v2", "files": changed}).status_code == 200
    assert client.put(path, headers=headers, json={"skill_id": "custom-fixture", "version": "v1", "files": changed}).status_code == 409
    assert client.delete(path, headers=headers).status_code == 204
    recreated = client.post("/api/manager/skills", headers=headers, json={"skill_id": "custom-fixture", "version": "v1", "files": changed})
    assert recreated.status_code == 409  # deletion cannot erase version fingerprints
    other = {"Authorization": f"Bearer {_token(two_tenants[1], ['owner'], admin_url=admin_url)}"}
    assert client.post("/api/manager/skills", headers=other, json={"skill_id": "custom-fixture", "version": "v1", "files": changed}).status_code == 201


def test_concurrent_package_and_metadata_writes_never_restore_old_files(migrated_db, two_tenants, admin_url):
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    service = CapabilityCatalogService(CapabilityCatalogRepository(router))
    original = service.create_skill(ctx, SkillCatalogIn(skill_id="concurrent", version="1", files=FILES))
    barrier = threading.Barrier(2)
    def write(body):
        barrier.wait()
        return service.update_skill(ctx, SkillCatalogIn(**body), catalog_id=original.catalog_id)
    changed = [{**FILES[0], "content": FILES[0]["content"] + "\nNew version"}]
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(write, body) for body in [
            {"skill_id": "concurrent", "display_name": "Renamed"},
            {"skill_id": "concurrent", "version": "2", "files": changed},
        ]]
        for future in futures:
            future.result()
    final = service.get_skill(ctx, catalog_id=original.catalog_id)
    assert final.display_name == "Renamed" and final.version == "2" and final.files[0]["content"] == changed[0]["content"]
    apply_migrations(admin_url, app_rw_password="apprwpass")
    with pytest.raises(Conflict):
        service.update_skill(ctx, SkillCatalogIn(skill_id="concurrent", version="1", files=changed), catalog_id=original.catalog_id)
    with router.session(ctx) as s:
        assert s.execute("SELECT count(*) FROM skill_package_revision WHERE skill_id='concurrent'").fetchone()[0] == 2
    other = TenantContext(tenant_id=two_tenants[1], user_id="other", roles=["owner"])
    with router.session(other) as s:
        assert s.execute("SELECT count(*) FROM skill_package_revision WHERE skill_id='concurrent'").fetchone()[0] == 0


def test_fileless_draft_and_legacy_invalid_remain_nonexecutable(migrated_db, two_tenants):
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    service = CapabilityCatalogService(CapabilityCatalogRepository(router))
    draft = service.create_skill(ctx, SkillCatalogIn(skill_id="draft"))
    assert draft.package_status == "draft"
    with router.session(ctx) as s:
        s.execute("UPDATE skill_catalog SET files=%s::jsonb, content_hash='' WHERE id=%s", ('[{"path":"SKILL.md","content":"# legacy missing description"}]', draft.catalog_id))
    renamed = service.update_skill(ctx, SkillCatalogIn(skill_id="draft", display_name="Metadata only"), catalog_id=draft.catalog_id)
    assert renamed.package_status == "invalid" and renamed.files[0]["content"] == "# legacy missing description"


def test_migration0039_preserves_scalar_and_object_skill_files_as_invalid(migrated_db, admin_url, two_tenants):
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    service = CapabilityCatalogService(CapabilityCatalogRepository(router))
    scalar = service.create_skill(ctx, SkillCatalogIn(skill_id="legacy-scalar", version="1"))
    object_row = service.create_skill(ctx, SkillCatalogIn(skill_id="legacy-object", version="1"))
    with router.session(ctx) as s:
        s.execute("UPDATE skill_catalog SET files=%s::jsonb WHERE id=%s", ('\"legacy scalar\"', scalar.catalog_id))
        s.execute("UPDATE skill_catalog SET files=%s::jsonb WHERE id=%s", ('{"legacy":true}', object_row.catalog_id))
    apply_migrations(admin_url, app_rw_password="apprwpass")
    scalar_out = service.get_skill(ctx, catalog_id=scalar.catalog_id)
    object_out = service.get_skill(ctx, catalog_id=object_row.catalog_id)
    assert scalar_out.package_status == "invalid"
    assert object_out.package_status == "invalid"
    with router.session(ctx) as s:
        rows = s.execute("SELECT files FROM skill_catalog WHERE id IN (%s, %s) ORDER BY skill_id", (scalar.catalog_id, object_row.catalog_id)).fetchall()
    assert rows[0][0] != [] and rows[1][0] != []


def test_signed_distribution_after_metadata_edit_uses_verified_bytes_and_required_version(migrated_db, two_tenants):
    import base64

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from manager_service.authorized_config_service import AuthorizedConfigService
    from manager_service.skill_signing import SkillPackageSigner
    from shared.contracts.skill import canonical_skill_package_bytes
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="member-fixture", roles=["owner"])
    catalog = CapabilityCatalogService(CapabilityCatalogRepository(router))
    created = catalog.create_skill(ctx, SkillCatalogIn(skill_id="distributed", version="v1", files=FILES))
    catalog.update_skill(ctx, SkillCatalogIn(skill_id="distributed", display_name="Renamed"), catalog_id=created.catalog_id)
    key = Ed25519PrivateKey.generate()
    service = AuthorizedConfigService(config_service=None, grant_service=None, member_service=None,
                                     capability_catalog=catalog, skill_signer=SkillPackageSigner(key, "fixture"))
    packages = service._resolve_skill_packages(ctx, [{"skills": ["distributed", "distributed@v1", "distributed@old", "missing"]}])
    assert len(packages) == 1
    envelope = packages[0]
    assert envelope.package.content_hash == created.content_hash and envelope.package.files[0].content == FILES[0]["content"]
    assert envelope.package.display_name == "Renamed"
    key.public_key().verify(base64.b64decode(envelope.signature), canonical_skill_package_bytes(envelope.package, ctx.tenant_id, ctx.user_id))
    catalog.update_skill(ctx, SkillCatalogIn(skill_id="distributed", binding_policy="disabled"), catalog_id=created.catalog_id)
    assert service._resolve_skill_packages(ctx, [{"skills": ["distributed"]}]) == []
    draft = catalog.create_skill(ctx, SkillCatalogIn(skill_id="draft-only"))
    assert service._resolve_skill_packages(ctx, [{"skills": [draft.skill_id]}]) == []
    with router.session(ctx) as s:
        s.execute("UPDATE skill_catalog SET files=%s::jsonb WHERE id=%s", ('[{"path":"SKILL.md","content":"# tampered"}]', created.catalog_id))
        s.execute("UPDATE skill_catalog SET binding_policy='opt_in' WHERE id=%s", (created.catalog_id,))
    assert service._resolve_skill_packages(ctx, [{"skills": ["distributed"]}]) == []


def test_installable_summaries_judge_package_shape_in_sql_without_returning_files(migrated_db, two_tenants):
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    repo = CapabilityCatalogRepository(router)
    service = CapabilityCatalogService(repo)
    ready = service.create_skill(ctx, SkillCatalogIn(skill_id="sum-ready", version="1", files=FILES))
    service.create_skill(ctx, SkillCatalogIn(skill_id="sum-draft"))
    for skill_id, files in (("sum-scalar", '"legacy"'), ("sum-object", '{"legacy":true}'),
                            ("sum-no-skill-md", '[{"path":"a.md","content":"x"}]')):
        row = service.create_skill(ctx, SkillCatalogIn(skill_id=skill_id, version="1"))
        with router.session(ctx) as s:
            s.execute("UPDATE skill_catalog SET files=%s::jsonb, content_hash='h' WHERE id=%s", (files, row.catalog_id))
    summaries = {row.skill_id: row for row in repo.list_skill_summaries(ctx)}
    assert not hasattr(summaries["sum-ready"], "files")
    assert summaries["sum-ready"].package_shaped and summaries["sum-ready"].content_hash == ready.content_hash
    for skill_id in ("sum-draft", "sum-scalar", "sum-object", "sum-no-skill-md"):
        assert summaries[skill_id].package_shaped is False, skill_id
    other = TenantContext(tenant_id=two_tenants[1], user_id="other", roles=["owner"])
    assert not any(row.skill_id.startswith("sum-") for row in repo.list_skill_summaries(other))


def test_platform_market_row_allows_only_the_enterprise_switches_in_sql(migrated_db, two_tenants):
    """Design §4.7: platform packages stay immutable even at the SQL guard, but 成员自装 / 停用 are the enterprise's."""
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    repo = CapabilityCatalogRepository(router)
    row = repo.create_skill(
        ctx, skill_id="platform-pg-switches", display_name="Platform", version="1.0.0", install_policy="on_demand",
        binding_policy="opt_in", visibility="tenant", config={"source": "operator"},
        files=[{"path": "SKILL.md", "content": "---\nname: x\ndescription: d\n---\n"}], content_hash="hash",
    )
    service = CapabilityCatalogService(repo)
    switched = service.update_skill(ctx, SkillCatalogIn(skill_id="platform-pg-switches", visibility="private", binding_policy="disabled"), catalog_id=row.catalog_id)
    assert (switched.visibility, switched.binding_policy, switched.version, switched.content_hash) == ("private", "disabled", "1.0.0", "hash")
    unset = {"display_name": None, "version": None, "install_policy": None, "binding_policy": None, "visibility": None, "config": None}
    for change in ({"display_name": "Renamed"}, {"version": "2"}, {"config": {}}, {"files": [], "content_hash": "other"}):
        assert repo.update_skill(ctx, catalog_id=row.catalog_id, **{**unset, **change}) is None
    with pytest.raises(Conflict, match="immutable"):
        service.update_skill(ctx, SkillCatalogIn(skill_id="platform-pg-switches", display_name="Renamed"), catalog_id=row.catalog_id)
    assert repo.get_skill(ctx, catalog_id=row.catalog_id).display_name == "Platform"


def test_platform_package_moves_in_place_and_only_for_platform_rows(migrated_db, two_tenants):
    """Design「技能MCP命名空间出处与更新提示」§4.3: one row per platform skill; updates keep id, switches and bindings."""
    router = PgTenantRouter(migrated_db)
    ctx = TenantContext(tenant_id=two_tenants[0], user_id="fixture", roles=["owner"])
    repo = CapabilityCatalogRepository(router)
    files = [{"path": "SKILL.md", "content": "---\nname: x\ndescription: d\n---\n"}]
    row = repo.create_skill(ctx, skill_id="platform-pg-move", display_name="X", version="1", install_policy="on_demand",
                            binding_policy="disabled", visibility="private", config={"source": "operator", "source_version": "1"},
                            files=files, content_hash="h1")
    moved = repo.replace_platform_package(ctx, catalog_id=row.catalog_id, display_name="X2", version="2",
                                          config={"source": "operator", "source_version": "2"}, files=files, content_hash="h2")
    assert (moved.skill_id, moved.version, moved.content_hash, moved.visibility, moved.binding_policy) == ("platform-pg-move", "2", "h2", "private", "disabled")
    assert moved.catalog_version > row.catalog_version
    own = repo.create_skill(ctx, skill_id="own-pg-move", display_name="o", version="1", install_policy="on_demand", binding_policy="opt_in",
                            visibility="tenant", config={"source": "custom"}, files=files, content_hash="h")
    assert repo.replace_platform_package(ctx, catalog_id=own.catalog_id, display_name="o", version="2", config={"source": "operator"},
                                         files=files, content_hash="h2") is None
    other = TenantContext(tenant_id=two_tenants[1], user_id="fixture", roles=["owner"])
    assert repo.replace_platform_package(other, catalog_id=row.catalog_id, display_name="x", version="3", config={"source": "operator"},
                                         files=files, content_hash="h3") is None
