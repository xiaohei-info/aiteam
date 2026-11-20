"""Enterprise admin imports a skill into the tenant catalog (design 2026-11-20 §4.3, P2).

Sources, mirroring the desktop's local import (`server/agent_service/src/custom-skills.ts`):
folder / zip / single .md (uploaded), pasted SKILL.md, the console's SKILL.md editor, a public https URL
(GitHub / .zip / .md) and ClawHub. Everything except ClawHub lives in `shared.skill_sources`, shared with the
Operator custom platform skills.

* `preview` validates every skill root found in the source and writes nothing;
* `install` writes the chosen roots into `skill_catalog` (new entry, or a new version of the same name);
* remote sources go through `shared.net_guard` (https only, public addresses pinned, same-host redirects,
  20 s, 10 MiB) — Manager may call out only for this admin import (decision C);
* ClawHub security scans are shown, never enforced (decision B);
* nothing is executed; the audit trail records who imported what, never file contents.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import quote, urlencode

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden, ValidationProblem
from shared.net_guard import Fetch
from shared.skill_import import (
    CLAWHUB_REGISTRY_FILES,
    SkippedFile,
    clawhub_url_parts,
    normalize_security,
    skill_roots,
    unzip_entries,
)
from shared.skill_sources import (  # noqa: F401 (SkillSourceUnavailable re-exported)
    Gathered,
    Origin,
    SkillSourceUnavailable,
    SourceGatherer,
    read_skill,
)

from .capability_origin import fork_provenance, import_provenance
from .capability_catalog_repository import CapabilityCatalogRepository, SkillCatalogRow

Source = Literal["folder", "zip", "file", "text", "editor", "url", "clawhub"]
SOURCES: tuple[Source, ...] = ("folder", "zip", "file", "text", "editor", "url", "clawhub")
_WRITE_ROLES = {"owner", "enterprise_admin"}


@dataclass
class ImportRequest:
    source: Source
    entries: list[tuple[str, bytes]] = field(default_factory=list)  # folder / zip / file uploads
    text: str = ""
    url: str = ""
    roots: list[str] | None = None
    fork_of: str = ""  # editor: catalog_id of the platform-market row being edited into the enterprise's own copy


@dataclass
class _Analysis:
    root: str
    ok: bool
    reason: str = ""
    name: str = ""
    description: str = ""
    version: str = ""
    content_hash: str = ""
    files: list[dict[str, str]] = field(default_factory=list)
    skipped: list[SkippedFile] = field(default_factory=list)
    existing: Literal["none", "same", "update"] = "none"
    existing_row: SkillCatalogRow | None = None

    def summary(self) -> dict[str, Any]:
        sizes = [{"path": f["path"], "size": len(f["content"].encode("utf-8"))} for f in self.files]
        return {
            "root": self.root, "ok": self.ok, **({"reason": self.reason} if self.reason else {}),
            "name": self.name, "description": self.description, "version": self.version,
            "file_count": len(sizes), "total_bytes": sum(item["size"] for item in sizes), "files": sizes,
            "skipped": [{"path": item.path, "reason": item.reason} for item in self.skipped],
            "existing": self.existing,
            **({"existing_version": self.existing_row.version} if self.existing_row is not None else {}),
        }


def clawhub_base_url() -> str:
    return (os.environ.get("AITEAM_CLAWHUB_BASE_URL") or "https://clawhub.ai").rstrip("/")


class SkillImportService:
    def __init__(self, repo: CapabilityCatalogRepository, *, fetch: Fetch | None = None, audit: Any = None,
                 clawhub_base: str | None = None):
        self._repo = repo
        self._sources = SourceGatherer(fetch)
        self._audit = audit
        self._clawhub = (clawhub_base or clawhub_base_url()).rstrip("/")

    # ---- public ----

    def preview(self, ctx: TenantContext, request: ImportRequest) -> dict[str, Any]:
        _ensure_can_write(ctx)
        gathered = self._gather(request)
        if gathered.clawhub and gathered.clawhub.get("candidates"):
            return {"clawhub": gathered.clawhub, "origin": gathered.origin.as_dict()}
        items = [self._analyze(ctx, gathered.entries, root).summary() for root in self._roots(gathered, request)]
        out: dict[str, Any] = {"origin": gathered.origin.as_dict(), **({"clawhub": gathered.clawhub} if gathered.clawhub else {})}
        # One skill keeps the single preview shape the desktop uses; several are listed for picking.
        return {**out, "preview": items[0]} if len(items) == 1 else {**out, "scan": items}

    def install(self, ctx: TenantContext, request: ImportRequest, *, visibility: str, binding_policy: str,
                install_policy: str) -> dict[str, Any]:
        _ensure_can_write(ctx)
        gathered = self._gather(request)
        if gathered.clawhub and gathered.clawhub.get("candidates"):
            raise ValidationProblem("ClawHub 上有多个同名技能，请先在预览里选择作者")
        forked = self._fork_provenance(ctx, request.fork_of)
        analyses = [self._analyze(ctx, gathered.entries, root) for root in self._roots(gathered, request)]
        if request.roots is None:
            analyses = [item for item in analyses if item.ok]
            if not analyses:
                raise ValidationProblem("这个来源里没有可导入的技能")
        results = []
        for item in analyses:
            results.append(self._install_one(ctx, item, gathered, visibility=visibility,
                                             binding_policy=binding_policy, install_policy=install_policy, forked=forked))
        return {"origin": gathered.origin.as_dict(), "results": results}

    def _fork_provenance(self, ctx: TenantContext, fork_of: str) -> dict | None:
        """The platform-market row an enterprise copy is edited from; the row itself is left as it is."""
        if not fork_of:
            return None
        row = self._repo.get_skill(ctx, catalog_id=fork_of)
        if row is None or (row.config or {}).get("source") != "operator":
            raise ValidationProblem("只有从平台技能市场安装的技能需要另存为企业副本；企业自己的技能直接编辑")
        return fork_provenance(row.config, skill_id=row.skill_id, version=row.version)

    # ---- gathering ----

    def _gather(self, request: ImportRequest) -> Gathered:
        if request.source == "clawhub":
            if not request.url.strip():
                raise ValidationProblem("没有填写网址")
            return self._gather_clawhub(request.url.strip())
        return self._sources.gather(request.source, entries=request.entries, text=request.text, url=request.url)

    def _get(self, url: str, *, allow_status: tuple[int, ...] = (200,)) -> tuple[int, bytes]:
        return self._sources.get(url, allow_status=allow_status)

    def _gather_clawhub(self, raw: str) -> Gathered:
        parts = clawhub_url_parts(raw, base_url=self._clawhub)
        if parts is None:
            raise ValidationProblem(f"不是 ClawHub 技能地址：应为 {self._clawhub}/作者/skills/标识")
        owner, slug = parts
        if owner is None:
            candidates = self._clawhub_candidates(slug)
            if len(candidates) != 1:
                return Gathered([], Origin("clawhub", "ClawHub", raw), {"candidates": candidates, "security": None})
            owner = candidates[0]["owner"]
        page = f"{self._clawhub}/{owner}/skills/{slug}"
        query = urlencode({"slug": slug, "ownerHandle": owner})
        entries = [(path, data) for path, data in unzip_entries(self._get(f"{self._clawhub}/api/v1/download?{query}")[1])
                   if path not in CLAWHUB_REGISTRY_FILES]
        return Gathered(entries, Origin("clawhub", "ClawHub", page),
                         {"candidates": None, "security": self._clawhub_security(owner, slug), "owner": owner, "slug": slug})

    def _clawhub_candidates(self, slug: str) -> list[dict[str, str]]:
        status, body = self._get(f"{self._clawhub}/api/v1/skills/{quote(slug, safe='')}", allow_status=(200, 409))
        data = json.loads(body or b"{}")
        if status == 200:
            handle = str((data.get("owner") or {}).get("handle") or "")
            return [{"owner": handle, "slug": slug, "url": f"{self._clawhub}/{handle}/skills/{slug}"}] if handle else []
        return [
            {"owner": str(item["ownerHandle"]), "slug": str(item.get("slug") or slug),
             "url": str(item.get("url") or f"{self._clawhub}/{item['ownerHandle']}/skills/{slug}")}
            for item in data.get("matches") or [] if item.get("ownerHandle")
        ]

    def _clawhub_security(self, owner: str, slug: str) -> dict[str, Any] | None:
        try:
            _status, body = self._get(f"{self._clawhub}/api/v1/skills/{quote(slug, safe='')}/scan?{urlencode({'ownerHandle': owner})}")
            return normalize_security(json.loads(body or b"{}"))
        except (AppError, ValueError):
            return None  # shown as "no verdict"; never blocks

    # ---- analysis / install ----

    def _roots(self, gathered: Gathered, request: ImportRequest) -> list[str]:
        roots = skill_roots(gathered.entries)
        if not roots:
            raise ValidationProblem("这个来源里找不到 SKILL.md")
        if request.roots is None:
            return roots
        unknown = sorted(set(request.roots) - set(roots))
        if unknown:
            raise ValidationProblem(f"包里没有这些技能目录：{'、'.join(unknown)}")
        return [root for root in roots if root in request.roots]

    def _analyze(self, ctx: TenantContext, entries: list[tuple[str, bytes]], root: str) -> _Analysis:
        read = read_skill(entries, root)
        item = _Analysis(root=root, ok=False, reason=read.reason, name=read.name, description=read.description,
                         files=read.files, skipped=read.skipped)
        if not read.ok:
            return item
        if read.name.startswith("platform-"):
            item.reason = "platform- 开头的名称留给平台技能市场"
            return item
        item.content_hash = read.content_hash
        item.version = read.declared_version or read.content_hash[:12]
        existing = self._repo.get_skill_by_id(ctx, skill_id=read.name)
        item.existing_row = existing
        if existing is not None:
            if (existing.config or {}).get("source") == "operator":
                item.reason = f"「{read.name}」是从平台技能市场安装的技能，不能被覆盖；请改 SKILL.md 里的 name"
                return item
            if existing.content_hash == item.content_hash:
                item.existing = "same"
            else:
                item.existing = "update"
                if existing.version == item.version:
                    item.version = f"{item.version}-{item.content_hash[:8]}"
        item.ok = True
        return item

    def _install_one(self, ctx: TenantContext, item: _Analysis, gathered: Gathered, *, visibility: str,
                     binding_policy: str, install_policy: str, forked: dict | None = None) -> dict[str, Any]:
        base = {"root": item.root, "name": item.name, "version": item.version}
        if not item.ok:
            return {**base, "status": "failed", "reason": item.reason}
        if item.existing == "same":
            return {**base, "version": item.existing_row.version, "status": "duplicate", "reason": "目录里已有内容相同的这个技能"}
        config = {
            "source": "clawhub" if gathered.origin.kind == "clawhub" else "url" if gathered.origin.kind == "url" else "custom",
            "origin": gathered.origin.as_dict(),
            "provenance": import_provenance(gathered.origin.kind, gathered.origin.url, gathered.clawhub,
                                            item.existing_row.config if item.existing_row else None, forked),
            "description": item.description,
            **({"skipped": [{"path": s.path, "reason": s.reason} for s in item.skipped]} if item.skipped else {}),
            **({"security": gathered.clawhub["security"]} if gathered.clawhub and gathered.clawhub.get("security") else {}),
        }
        try:
            if item.existing_row is None:
                row = self._repo.create_skill(
                    ctx, skill_id=item.name, display_name=item.name, version=item.version,
                    install_policy=install_policy, binding_policy=binding_policy, visibility=visibility,
                    config=config, files=item.files, content_hash=item.content_hash,
                )
                status = "installed"
            else:
                # An update keeps the entry's visibility and policies: importing must not widen who can use it.
                row = self._repo.update_skill(
                    ctx, catalog_id=item.existing_row.catalog_id, display_name=None, version=item.version,
                    install_policy=None, binding_policy=None, visibility=None,
                    # The previous source's scan and skip list describe the old files; never carry them over.
                    config={**{k: v for k, v in (item.existing_row.config or {}).items() if k not in ("security", "skipped")}, **config},
                    files=item.files, content_hash=item.content_hash,
                )
                if row is None:
                    return {**base, "status": "failed", "reason": "目录里的这个技能刚被删除或改动，请重新检查"}
                status = "updated"
        except AppError as exc:
            return {**base, "status": "failed", "reason": exc.detail or exc.title}
        if self._audit is not None:
            self._audit.record(
                ctx, actor=ctx.user_id, action="skill_catalog.imported", resource_type="skill", resource_id=row.catalog_id,
                detail=f"skill_id={item.name} version={item.version} source={gathered.origin.kind} files={len(item.files)} {status}",
            )
        return {**base, "status": status, "catalog_id": row.catalog_id}


def _ensure_can_write(ctx: TenantContext) -> None:
    if not set(ctx.roles) & _WRITE_ROLES:
        raise Forbidden("importing skills requires owner or enterprise_admin")
