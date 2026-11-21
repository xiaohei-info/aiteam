"""Install Operator-published immutable skills into a Manager tenant catalog."""

from __future__ import annotations

from dataclasses import dataclass

from shared.capability_namespace import PLATFORM_NAMESPACE, clawhub_provenance, normalize_provenance
from shared.contracts.platform_skill import PlatformSkillRef
from shared.contracts.skill import SkillFile, SkillPackage, derive_file_hash
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict
from shared.skill_sources import frontmatter

from .capability_catalog_repository import CapabilityCatalogRepository
from .operator_catalog import OperatorCatalogPort


@dataclass(frozen=True)
class InstalledPlatformSkill:
    skill_id: str
    version: str
    content_hash: str
    installed: bool


@dataclass(frozen=True)
class PreparedPlatformSkill:
    """Validated Operator bytes carried into a local publication transaction."""

    ref: PlatformSkillRef
    package: SkillPackage
    owner: str
    slug: str
    namespace: str = PLATFORM_NAMESPACE
    provenance: dict | None = None


def _tenant_skill_id(ref: PlatformSkillRef) -> str:
    """One tenant row per platform skill; it keeps this id across versions (updates replace it in place)."""
    return f"platform-{ref.skill_id}"


def _skill_name(package: SkillPackage, fallback: str) -> str:
    skill_md = next((file.content for file in package.files if file.path == "SKILL.md"), "")
    return str(frontmatter(skill_md).get("name") or fallback)


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
            origin = _market_origin(item)
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
                **origin,
            })
        return result

    def prepare(self, ctx: TenantContext, ref: PlatformSkillRef) -> PreparedPlatformSkill:
        """Fetch and validate immutable Operator bytes before local writes begin."""
        del ctx  # The remote package is selected only by its pinned public ref.
        remote = self._operator.pull_platform_skill(skill_id=ref.skill_id, version=ref.version)
        package = remote.package
        if package.skill_id != ref.skill_id or package.version != ref.version or package.content_hash != ref.content_hash:
            raise Conflict("Operator platform skill package does not match the pinned reference")
        package.validate_package()
        origin = self._origin(ref.skill_id, remote.owner, remote.slug)
        return PreparedPlatformSkill(ref=ref, package=package, owner=remote.owner, slug=remote.slug, **origin)

    def _origin(self, skill_id: str, owner: str, slug: str) -> dict:
        """namespace / provenance as Operator lists them; older Operator (or an unreachable list) → from owner/slug."""
        try:
            item = next((item for item in self._operator.list_platform_skills() if str(item.get("skill_id")) == skill_id), None)
        except Exception:  # noqa: BLE001 - display-only fields must not block an install
            item = None
        return _market_origin(item if item is not None else {"owner": owner, "slug": slug})

    def prepare_all(self, ctx: TenantContext, refs: list[PlatformSkillRef | dict]) -> list[PreparedPlatformSkill]:
        return [self.prepare(ctx, raw if isinstance(raw, PlatformSkillRef) else PlatformSkillRef.model_validate(raw)) for raw in refs]

    def install(self, ctx: TenantContext, ref: PlatformSkillRef) -> InstalledPlatformSkill:
        """Market 「安装 / 更新」: an already installed platform skill moves to this version in place."""
        return self.install_prepared(ctx, self.prepare(ctx, ref), replace=True)

    def install_prepared(self, ctx: TenantContext, prepared: PreparedPlatformSkill, *, replace: bool = False) -> InstalledPlatformSkill:
        """Install already-validated bytes; this method performs no remote IO.

        One tenant row per platform skill (design「技能MCP命名空间出处与更新提示」§4.3). When the enterprise already has
        it at another version, `replace=True` (the market's 更新) moves that row to this version — skill_id, switches
        and expert bindings stay — and `replace=False` (recruiting / applying a solution) keeps what the enterprise has.
        """
        ref = prepared.ref
        package = prepared.package
        package.validate_package()
        files = [{"path": file.path, "content": file.content} for file in package.files]
        config = {
            "source": "operator", "source_skill_id": ref.skill_id, "source_version": ref.version, "source_content_hash": ref.content_hash,
            "owner": prepared.owner, "slug": prepared.slug, "namespace": prepared.namespace, "provenance": prepared.provenance,
            "skill_name": _skill_name(package, prepared.slug),
        }
        rows = [row for row in self._catalog.list_skills(ctx)
                if row.config.get("source") == "operator" and row.config.get("source_skill_id") == ref.skill_id]
        same = next((row for row in rows if row.version == ref.version and row.content_hash == ref.content_hash), None)
        if same is not None:
            self._check_same(same, ref)
            return InstalledPlatformSkill(same.skill_id, ref.version, ref.content_hash, False)
        if rows:
            current = rows[-1]  # older data may hold several rows of one platform skill; the newest one moves
            if not replace:
                return InstalledPlatformSkill(current.skill_id, current.version, current.content_hash, False)
            moved = self._catalog.replace_platform_package(
                ctx, catalog_id=current.catalog_id, display_name=package.display_name, version=package.version,
                config={**current.config, **config}, files=files, content_hash=package.content_hash,
            )
            if moved is None:
                raise Conflict("企业技能目录里的这个平台技能刚被改动，请刷新后重试")
            return InstalledPlatformSkill(current.skill_id, ref.version, ref.content_hash, True)
        tenant_skill_id = _tenant_skill_id(ref)
        if self._catalog.get_skill_by_id(ctx, skill_id=tenant_skill_id) is not None:
            raise Conflict("existing tenant skill does not match the immutable Operator package")
        self._catalog.create_skill(
            ctx,
            skill_id=tenant_skill_id,
            display_name=package.display_name,
            version=package.version,
            install_policy="on_demand",
            binding_policy="opt_in",
            visibility="tenant",
            config=config,
            files=files,
            content_hash=package.content_hash,
        )
        return InstalledPlatformSkill(tenant_skill_id, ref.version, ref.content_hash, True)

    @staticmethod
    def _check_same(existing, ref: PlatformSkillRef) -> None:
        """An installed row claiming this exact version must still hold its bytes."""
        existing_files = existing.files if isinstance(existing.files, list) else []
        try:
            existing_package = SkillPackage(
                skill_id=ref.skill_id,
                version=existing.version,
                content_hash=existing.content_hash,
                files=[
                    SkillFile(path=str(item.get("path", "")), content=str(item.get("content", "")), content_hash=derive_file_hash(str(item.get("content", ""))))
                    for item in existing_files if isinstance(item, dict)
                ],
            )
        except (TypeError, ValueError):
            raise Conflict("existing tenant skill does not match the immutable Operator package") from None
        if existing_package.compute_content_hash() != ref.content_hash:
            raise Conflict("existing tenant skill does not match the immutable Operator package")

    def install_prepared_all(self, ctx: TenantContext, plans: list[PreparedPlatformSkill]) -> list[str]:
        return [self.install_prepared(ctx, plan).skill_id for plan in plans]

    def validate_all(self, ctx: TenantContext, refs: list[PlatformSkillRef | dict]) -> list[dict]:
        """Validate pinned packages without writing the tenant catalog."""
        normalized: list[dict] = []
        for raw in refs:
            ref = raw if isinstance(raw, PlatformSkillRef) else PlatformSkillRef.model_validate(raw)
            remote = self._operator.pull_platform_skill(skill_id=ref.skill_id, version=ref.version)
            package = remote.package
            if package.skill_id != ref.skill_id or package.version != ref.version or package.content_hash != ref.content_hash:
                raise Conflict("Operator platform skill package does not match the pinned reference")
            package.validate_package()
            normalized.append(ref.model_dump(mode="json"))
        return normalized

    def install_all(self, ctx: TenantContext, refs: list[PlatformSkillRef | dict]) -> list[str]:
        """Recruiting / applying a solution: a platform skill the enterprise already has is used as it is."""
        return [self.install_prepared(ctx, plan).skill_id for plan in self.prepare_all(ctx, refs)]


def _market_origin(item: dict) -> dict:
    """namespace / provenance of an Operator list item (older Operator sends neither: derive from owner/slug)."""
    if "namespace" in item:
        return {"namespace": str(item.get("namespace") or ""), "provenance": normalize_provenance(item.get("provenance"))}
    owner, slug = str(item.get("owner") or ""), str(item.get("slug") or "")
    if owner and owner != "platform" and slug:
        return {"namespace": "", "provenance": clawhub_provenance(owner, slug)}
    return {"namespace": PLATFORM_NAMESPACE, "provenance": None}
