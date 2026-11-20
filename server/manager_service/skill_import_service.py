"""Enterprise admin imports a skill into the tenant catalog (design 2026-11-20 §4.3, P2).

Six sources, mirroring the desktop's local import (`server/agent_service/src/custom-skills.ts`):
folder / zip / single .md (uploaded), pasted SKILL.md, a public https URL (GitHub / .zip / .md) and ClawHub.

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
import re
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import quote, urlencode, urlsplit

import yaml

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden, ValidationProblem
from shared.net_guard import Blocked, Fetch, FetchFailed, get, pinned_fetch
from shared.skill_import import (
    CLAWHUB_REGISTRY_FILES,
    MAX_ARCHIVE_BYTES,
    SkippedFile,
    clawhub_url_parts,
    entries_at_root,
    normalize_files,
    normalize_security,
    skill_roots,
    unzip_entries,
)

from .capability_catalog_repository import CapabilityCatalogRepository, SkillCatalogRow
from .custom_skill_package import catalog_package, validate_skill_frontmatter

Source = Literal["folder", "zip", "file", "text", "url", "clawhub"]
SOURCES: tuple[Source, ...] = ("folder", "zip", "file", "text", "url", "clawhub")
DOWNLOAD_TIMEOUT_S = 20.0
_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Same character set as the signed package's version segment; a leading dot is never a version.
_VERSION = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$")
_WRITE_ROLES = {"owner", "enterprise_admin"}
SOURCE_LABELS: dict[str, str] = {"folder": "上传的文件夹", "zip": "上传的压缩包", "file": "上传的 .md 文件", "text": "粘贴的 SKILL.md"}


class SkillSourceUnavailable(AppError):
    status, code, title = 502, "skill_source_unavailable", "Skill source unavailable"


@dataclass
class ImportRequest:
    source: Source
    entries: list[tuple[str, bytes]] = field(default_factory=list)  # folder / zip / file uploads
    text: str = ""
    url: str = ""
    roots: list[str] | None = None


@dataclass
class _Origin:
    kind: str
    label: str
    url: str = ""

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "label": self.label, **({"url": self.url} if self.url else {})}


@dataclass
class _Gathered:
    entries: list[tuple[str, bytes]]
    origin: _Origin
    clawhub: dict[str, Any] | None = None


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
        self._fetch = fetch
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
        analyses = [self._analyze(ctx, gathered.entries, root) for root in self._roots(gathered, request)]
        if request.roots is None:
            analyses = [item for item in analyses if item.ok]
            if not analyses:
                raise ValidationProblem("这个来源里没有可导入的技能")
        results = []
        for item in analyses:
            results.append(self._install_one(ctx, item, gathered, visibility=visibility,
                                             binding_policy=binding_policy, install_policy=install_policy))
        return {"origin": gathered.origin.as_dict(), "results": results}

    # ---- gathering ----

    def _gather(self, request: ImportRequest) -> _Gathered:
        if request.source in ("folder", "file", "zip"):
            if not request.entries:
                raise ValidationProblem("没有上传文件")
            entries = request.entries
            if request.source == "zip":
                if len(entries) != 1:
                    raise ValidationProblem("一次上传一个压缩包")
                entries = unzip_entries(entries[0][1])
            elif request.source == "file":
                if len(entries) != 1 or not entries[0][0].lower().endswith(".md"):
                    raise ValidationProblem("请上传一个 .md 文件")
                entries = [("SKILL.md", entries[0][1])]
            return _Gathered(entries, _Origin(request.source, SOURCE_LABELS[request.source]))
        if request.source == "text":
            if not request.text.strip():
                raise ValidationProblem("没有粘贴 SKILL.md 内容")
            return _Gathered([("SKILL.md", request.text.encode("utf-8"))], _Origin("text", SOURCE_LABELS["text"]))
        if not request.url.strip():
            raise ValidationProblem("没有填写网址")
        if request.source == "clawhub":
            return self._gather_clawhub(request.url.strip())
        return self._gather_url(request.url.strip())

    def _get(self, url: str, *, allow_status: tuple[int, ...] = (200,)) -> tuple[int, bytes]:
        fetch = self._fetch or pinned_fetch(max_bytes=MAX_ARCHIVE_BYTES)
        try:
            status, _headers, body = get(url, fetch=fetch, timeout_s=DOWNLOAD_TIMEOUT_S, allow_status=allow_status)
        except Blocked as exc:
            raise ValidationProblem(str(exc)) from exc
        except FetchFailed as exc:
            raise SkillSourceUnavailable(f"{exc}（{urlsplit(url).netloc}）") from exc
        return status, body

    def _gather_url(self, raw: str) -> _Gathered:
        url = urlsplit(raw)
        if url.scheme != "https" or not url.netloc:
            raise ValidationProblem("只支持 https 网址")
        origin = _Origin("url", raw, raw)
        github = _github_parts(url.netloc, url.path)
        if github is not None:
            owner, repo, kind, ref, rest = github
            if kind == "blob":
                return _Gathered([("SKILL.md", self._get(f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{rest}")[1])], origin)
            branch = ref or "main"
            files = unzip_entries(self._get(f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{quote(branch)}")[1])
            if kind != "tree" or not rest:
                return _Gathered(files, origin)
            nested = entries_at_root(files, f"{repo}-{branch.replace('/', '-')}/{rest}")
            if not nested:
                raise ValidationProblem(f"压缩包里找不到子目录：{rest}")
            return _Gathered(nested, origin)
        lower = url.path.lower()
        if lower.endswith(".zip"):
            return _Gathered(unzip_entries(self._get(raw)[1]), origin)
        if lower.endswith(".md"):
            return _Gathered([("SKILL.md", self._get(raw)[1])], origin)
        raise ValidationProblem("网址只能是 GitHub 链接、以 .md 结尾的文件，或以 .zip 结尾的压缩包")

    def _gather_clawhub(self, raw: str) -> _Gathered:
        parts = clawhub_url_parts(raw, base_url=self._clawhub)
        if parts is None:
            raise ValidationProblem(f"不是 ClawHub 技能地址：应为 {self._clawhub}/作者/skills/标识")
        owner, slug = parts
        if owner is None:
            candidates = self._clawhub_candidates(slug)
            if len(candidates) != 1:
                return _Gathered([], _Origin("clawhub", "ClawHub", raw), {"candidates": candidates, "security": None})
            owner = candidates[0]["owner"]
        page = f"{self._clawhub}/{owner}/skills/{slug}"
        query = urlencode({"slug": slug, "ownerHandle": owner})
        entries = [(path, data) for path, data in unzip_entries(self._get(f"{self._clawhub}/api/v1/download?{query}")[1])
                   if path not in CLAWHUB_REGISTRY_FILES]
        return _Gathered(entries, _Origin("clawhub", "ClawHub", page),
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

    def _roots(self, gathered: _Gathered, request: ImportRequest) -> list[str]:
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
        normalized = normalize_files(entries_at_root(entries, root))
        item = _Analysis(root=root, ok=False, files=normalized.files, skipped=normalized.skipped)
        skill_md = next((f["content"] for f in normalized.files if f["path"] == "SKILL.md"), None)
        if skill_md is None:
            item.reason = "SKILL.md 不是 UTF-8 文本，或路径不受支持"
            return item
        try:
            validate_skill_frontmatter(skill_md)
            meta = _frontmatter(skill_md)
        except (ValueError, yaml.YAMLError):
            item.reason = "SKILL.md 开头的元数据（--- 之间）格式不对，或缺少 description"
            return item
        name = str(meta.get("name") or "").strip()
        item.description = str(meta.get("description") or "").strip()
        if not name:
            item.reason = "SKILL.md 缺少 name"
            return item
        item.name = name
        if len(name) > 64 or not _NAME.fullmatch(name):
            item.reason = "name 只能用小写字母、数字和单个连字符，不超过 64 个字符"
            return item
        if name.startswith("platform-"):
            item.reason = "platform- 开头的名称留给平台技能市场"
            return item
        try:
            package = catalog_package(skill_id=name, version="0", files=normalized.files, display_name=name)
        except (ValueError, TypeError, KeyError) as exc:
            item.reason = f"技能包不符合规则：{exc}"
            return item
        item.content_hash = package.content_hash
        declared = str(meta.get("version") or "").strip()
        item.version = declared if _VERSION.fullmatch(declared) else package.content_hash[:12]
        existing = self._repo.get_skill_by_id(ctx, skill_id=name)
        item.existing_row = existing
        if existing is not None:
            if (existing.config or {}).get("source") == "operator":
                item.reason = f"「{name}」是从平台技能市场安装的技能，不能被覆盖；请改 SKILL.md 里的 name"
                return item
            if existing.content_hash == item.content_hash:
                item.existing = "same"
            else:
                item.existing = "update"
                if existing.version == item.version:
                    item.version = f"{item.version}-{item.content_hash[:8]}"
        item.ok = True
        return item

    def _install_one(self, ctx: TenantContext, item: _Analysis, gathered: _Gathered, *, visibility: str,
                     binding_policy: str, install_policy: str) -> dict[str, Any]:
        base = {"root": item.root, "name": item.name, "version": item.version}
        if not item.ok:
            return {**base, "status": "failed", "reason": item.reason}
        if item.existing == "same":
            return {**base, "version": item.existing_row.version, "status": "duplicate", "reason": "目录里已有内容相同的这个技能"}
        config = {
            "source": "clawhub" if gathered.origin.kind == "clawhub" else "url" if gathered.origin.kind == "url" else "custom",
            "origin": gathered.origin.as_dict(),
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
                    config={**(item.existing_row.config or {}), **config}, files=item.files, content_hash=item.content_hash,
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


def _frontmatter(text: str) -> dict[str, Any]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.DOTALL)
    meta = yaml.safe_load(match.group(1)) if match else None
    return meta if isinstance(meta, dict) else {}


def _github_parts(host: str, path: str) -> tuple[str, str, str, str, str] | None:
    """github.com/{owner}/{repo}[/(tree|blob)/{ref}/{rest}] → (owner, repo, kind, ref, rest); same rule as the desktop."""
    if host.lower() not in {"github.com", "www.github.com"}:
        return None
    parts = [part for part in path.split("/") if part]
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1].removesuffix(".git")
    if len(parts) >= 4 and parts[2] in {"tree", "blob"}:
        return owner, repo, parts[2], parts[3], "/".join(parts[4:])
    return owner, repo, "", "", ""
