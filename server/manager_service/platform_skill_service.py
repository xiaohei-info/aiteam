"""Install Operator-published immutable skills into a Manager tenant catalog."""

from __future__ import annotations

from dataclasses import dataclass

from shared.contracts.platform_skill import PlatformSkillRef
from shared.contracts.skill import SkillFile, SkillPackage, derive_file_hash
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

from .capability_catalog_repository import CapabilityCatalogRepository
from .operator_catalog import OperatorCatalogPort


@dataclass(frozen=True)
class InstalledPlatformSkill:
    skill_id: str
    version: str
    content_hash: str
    installed: bool


def _tenant_skill_id(ref: PlatformSkillRef) -> str:
    return f"platform-{ref.skill_id}-{ref.version}-{ref.content_hash[:16]}"


class PlatformSkillService:
    def __init__(self, *, operator: OperatorCatalogPort, catalog: CapabilityCatalogRepository):
        self._operator = operator
        self._catalog = catalog

    def list_market(self, ctx: TenantContext) -> list[dict]:
        installed: dict[str, list] = {}
        for row in self._catalog.list_skills(ctx):
            if row.config.get("source") == "operator":
                installed.setdefault(str(row.config.get("source_skill_id")), []).append(row)
        result: list[dict] = []
        for item in self._operator.list_platform_skills():
            skill_id = str(item.get("skill_id") or "")
            rows = installed.get(skill_id, [])
            published_version = item.get("published_version")
            content_hash = item.get("content_hash")
            current = next((row for row in rows if row.version == published_version and row.content_hash == content_hash), None)
            # Operator's internal DTO also contains import/version bookkeeping fields;
            # keep the Manager market response to the page contract instead of passing
            # those fields into its strict response model.
            result.append({
                "skill_id": skill_id,
                "display_name": str(item.get("display_name") or ""),
                "summary": str(item.get("summary") or ""),
                "owner": item.get("owner"),
                "slug": item.get("slug"),
                "published_version": published_version,
                "content_hash": content_hash,
                "installed": bool(rows),
                "installed_version": current.version if current else rows[-1].version if rows else None,
                "installed_content_hash": current.content_hash if current else rows[-1].content_hash if rows else None,
                "installed_versions": sorted({row.version for row in rows}),
                "update_available": bool(rows) and current is None,
            })
        return result

    def install(self, ctx: TenantContext, ref: PlatformSkillRef) -> InstalledPlatformSkill:
        remote = self._operator.pull_platform_skill(skill_id=ref.skill_id, version=ref.version)
        package = remote.package
        tenant_skill_id = _tenant_skill_id(ref)
        if package.skill_id != ref.skill_id or package.version != ref.version or package.content_hash != ref.content_hash:
            raise Conflict("Operator platform skill package does not match the pinned reference")
        package.validate_package()
        files = [{"path": file.path, "content": file.content} for file in package.files]
        existing = self._catalog.get_skill_by_id(ctx, skill_id=tenant_skill_id)
        if existing is not None:
            existing_package = SkillPackage(
                skill_id=ref.skill_id,
                version=existing.version,
                content_hash=existing.content_hash,
                files=[
                    SkillFile(path=str(item.get("path", "")), content=str(item.get("content", "")), content_hash=derive_file_hash(str(item.get("content", ""))))
                    for item in existing.files if isinstance(item, dict)
                ],
            )
            identity_matches = (
                existing.config.get("source") == "operator"
                and existing.config.get("source_skill_id") == ref.skill_id
                and existing.config.get("source_version") == ref.version
                and existing.config.get("source_content_hash") == ref.content_hash
            )
            if identity_matches and existing.version == ref.version and existing.content_hash == ref.content_hash and existing_package.compute_content_hash() == ref.content_hash:
                return InstalledPlatformSkill(tenant_skill_id, ref.version, ref.content_hash, False)
            raise Conflict("existing tenant skill does not match the immutable Operator package")
            updated = self._catalog.update_skill(
                ctx,
                catalog_id=existing.catalog_id,
                display_name=package.display_name,
                version=package.version,
                install_policy=existing.install_policy,
                binding_policy=existing.binding_policy,
                visibility=existing.visibility,
                config={**existing.config, "source": "operator", "source_skill_id": ref.skill_id, "source_version": ref.version, "source_content_hash": ref.content_hash, "owner": remote.owner, "slug": remote.slug},
                files=files,
                content_hash=package.content_hash,
            )
            if updated is None:
                raise Conflict("installed skill changed during update")
            return InstalledPlatformSkill(tenant_skill_id, ref.version, ref.content_hash, True)
        self._catalog.create_skill(
            ctx,
            skill_id=tenant_skill_id,
            display_name=package.display_name,
            version=package.version,
            install_policy="on_demand",
            binding_policy="opt_in",
            visibility="tenant",
            config={"source": "operator", "source_skill_id": ref.skill_id, "source_version": ref.version, "source_content_hash": ref.content_hash, "owner": remote.owner, "slug": remote.slug},
            files=files,
            content_hash=package.content_hash,
        )
        return InstalledPlatformSkill(tenant_skill_id, ref.version, ref.content_hash, True)

    def install_all(self, ctx: TenantContext, refs: list[PlatformSkillRef | dict]) -> list[str]:
        ids: list[str] = []
        for raw in refs:
            ref = raw if isinstance(raw, PlatformSkillRef) else PlatformSkillRef.model_validate(raw)
            self.install(ctx, ref)
            ids.append(_tenant_skill_id(ref))
        return ids
