"""Operator-owned platform skills: ClawHub imports, custom skills (§4.7) and their immutable versions."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from shared.errors import Conflict, NotFound, TooManyRequests, ValidationProblem
from shared.skill_import import (  # noqa: F401 (clawhub_url_parts / normalize_security re-exported)
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

MAX_ZIP_BYTES = MAX_ARCHIVE_BYTES
REGISTRY_FILES = CLAWHUB_REGISTRY_FILES  # registry-generated; not part of the verified artifact


def _hash_files(files: list[dict[str, str]]) -> str:
    normalized = [(item["path"], item["content"]) for item in sorted(files, key=lambda x: x["path"])]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class ParsedSkillArchive:
    """Distributable text files of one ClawHub download, plus what was left out and why."""

    files: list[dict[str, str]]
    content_hash: str
    skipped: list[SkippedFile] = field(default_factory=list)


def parse_skill_zip(raw: bytes) -> ParsedSkillArchive:
    """Unpack a ClawHub archive into the shared signed-package shape (design 2026-11-20 §4.1).

    Scripts, assets and other UTF-8 files are kept; binaries, `hooks/<platform>/` and paths the contract
    cannot carry are skipped and reported. Registry-generated files are dropped.
    """
    entries = unzip_entries(raw)
    roots = skill_roots(entries)
    if not roots:
        raise ValidationProblem("skill archive must contain SKILL.md")
    if "" not in roots and len(roots) > 1:
        raise ValidationProblem("skill archive contains several skills")
    root = "" if "" in roots else roots[0]
    rebased = [(path, content) for path, content in entries_at_root(entries, root) if path not in REGISTRY_FILES]
    normalized = normalize_files(rebased)
    if not any(item["path"] == "SKILL.md" for item in normalized.files):
        raise ValidationProblem("skill archive must contain SKILL.md")
    return ParsedSkillArchive(normalized.files, _hash_files(normalized.files), normalized.skipped)




@dataclass(frozen=True)
class ExternalSkill:
    owner: str
    slug: str
    display_name: str
    summary: str
    version: str | None
    latest_version: str | None
    updated_at: int | None
    downloads: int
    canonical_url: str
    security_ok: bool | None = None


class ClawHubClient:
    def __init__(self, base_url: str = "https://clawhub.ai", *, timeout: float = 20.0, transport=None):
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)
        self._cache: dict[tuple, tuple[float, dict]] = {}

    @property
    def base_url(self) -> str:
        return str(self._client.base_url).rstrip("/")

    # Scan results are shown, not used as a filter (design 2026-11-20 decision B / #5).
    def browse(self, *, cursor: str | None = None, limit: int = 20, sort: str = "updated") -> tuple[list[ExternalSkill], str | None]:
        params: dict[str, Any] = {"family": "skill", "limit": min(max(limit, 1), 100), "sort": sort}
        if cursor:
            params["cursor"] = cursor
        body = self._json("/api/v1/packages", params)
        return [self._from_package(item) for item in body.get("items", []) if item.get("family") == "skill"], body.get("nextCursor")

    def search(self, query: str, *, limit: int = 20) -> list[ExternalSkill]:
        body = self._json("/api/v1/search", {"q": query, "limit": min(max(limit, 1), 100)})
        return [self._from_search(item) for item in body.get("results", [])]

    def detail(self, *, owner: str, slug: str) -> dict[str, Any]:
        return self._json(f"/api/v1/skills/{quote(slug, safe='')}", {"ownerHandle": owner})

    def verify(self, *, owner: str, slug: str, version: str) -> dict[str, Any]:
        return self._json(f"/api/v1/skills/{quote(slug, safe='')}/verify", {"ownerHandle": owner, "version": version}, cache=False)

    def scan(self, *, owner: str, slug: str, version: str) -> dict[str, Any] | None:
        """Security scan summary; None when ClawHub cannot provide it (shown as unknown, never blocks)."""
        try:
            return normalize_security(self._json(f"/api/v1/skills/{quote(slug, safe='')}/scan", {"ownerHandle": owner, "version": version}))
        except (httpx.HTTPError, ValueError, TooManyRequests):
            return None

    def candidates(self, slug: str) -> list[dict[str, str]]:
        """Owners publishing `slug`: ClawHub answers 409 AMBIGUOUS_SKILL_SLUG with `matches`, or 200 when unique."""
        response = self._client.get(f"/api/v1/skills/{quote(slug, safe='')}")
        if response.status_code == 429:
            raise TooManyRequests("ClawHub rate limit reached; retry later")
        if response.status_code == 404:
            raise NotFound("ClawHub 上找不到该技能")
        if response.status_code not in (200, 409):
            response.raise_for_status()
        body = response.json()
        if response.status_code == 200:
            owner = str((body.get("owner") or {}).get("handle") or "")
            return [{"owner": owner, "slug": slug, "url": f"{self.base_url}/{owner}/skills/{slug}"}] if owner else []
        return [
            {"owner": str(item.get("ownerHandle") or ""), "slug": str(item.get("slug") or slug), "url": str(item.get("url") or "")}
            for item in body.get("matches") or [] if item.get("ownerHandle")
        ]

    def download(self, *, owner: str, slug: str, version: str) -> bytes:
        chunks: list[bytes] = []
        total = 0
        with self._client.stream("GET", "/api/v1/download", params={"ownerHandle": owner, "slug": slug, "version": version}) as response:
            if response.status_code == 429:
                raise TooManyRequests("ClawHub rate limit reached; retry later")
            if response.status_code == 404:
                raise NotFound("ClawHub 上找不到该技能版本")
            response.raise_for_status()
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > MAX_ZIP_BYTES:
                    raise ValidationProblem("skill archive is too large")
                chunks.append(chunk)
        return b"".join(chunks)

    def _json(self, path: str, params: dict[str, Any], *, cache: bool = True) -> dict:
        key = (path, tuple(sorted((name, str(value)) for name, value in params.items())))
        cached = self._cache.get(key) if cache else None
        if cached and cached[0] > time.monotonic():
            return cached[1]
        response = self._client.get(path, params=params)
        if response.status_code == 429:
            raise TooManyRequests("ClawHub rate limit reached; retry later")
        if response.status_code == 404:
            raise NotFound("ClawHub 上找不到该技能或版本")
        response.raise_for_status()
        body = response.json()
        if cache:
            self._cache[key] = (time.monotonic() + 600, body)
        return body

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def _from_search(item: dict[str, Any]) -> ExternalSkill:
        owner = str((item.get("owner") or {}).get("handle") or item.get("ownerHandle") or "")
        slug = str(item.get("slug") or "")
        latest = str(item.get("version")) if item.get("version") else None
        return ExternalSkill(
            owner=owner, slug=slug, display_name=str(item.get("displayName") or ""),
            summary=str(item.get("summary") or ""), version=latest, latest_version=latest,
            updated_at=item.get("updatedAt"), downloads=int(item.get("downloads") or 0),
            canonical_url=f"https://clawhub.ai{item.get('canonicalUrl')}" if str(item.get("canonicalUrl") or "").startswith("/") else str(item.get("canonicalUrl") or ""),
        )

    @staticmethod
    def _from_package(item: dict[str, Any]) -> ExternalSkill:
        owner = str(item.get("ownerHandle") or "")
        slug = str(item.get("name") or "")
        stats = item.get("stats") or {}
        version = str(item.get("latestVersion")) if item.get("latestVersion") else None
        return ExternalSkill(
            owner=owner, slug=slug, display_name=str(item.get("displayName") or ""),
            summary=str(item.get("summary") or ""), version=version, latest_version=version,
            updated_at=item.get("updatedAt"), downloads=int(stats.get("downloads") or 0),
            canonical_url=f"https://clawhub.ai/{owner}/skills/{slug}" if owner and slug else "",
        )


CUSTOM_OWNER = "platform"  # external_owner of every custom platform skill; external_slug is the SKILL.md name


@dataclass(frozen=True)
class CustomSkillState:
    """What the platform already has under one custom skill name."""

    skill_id: str
    latest_version: str | None
    latest_hash: str | None
    versions: dict[str, str]  # version -> content_hash


def plan_custom_version(existing: CustomSkillState | None, *, content_hash: str, declared: str) -> tuple[str, str]:
    """(`none` | `same` | `update`, version) for saving `content_hash` under a custom skill name.

    Version = frontmatter `version`, else the first 12 hash characters; a taken version gets `-<hash8>`.
    Content identical to an older version makes that version current again instead of minting a new one.
    """
    version = declared or content_hash[:12]
    if existing is None:
        return "none", version
    if existing.latest_hash == content_hash:
        return "same", existing.latest_version or version
    earlier = next((v for v, h in existing.versions.items() if h == content_hash), None)
    if earlier is not None:
        return "update", earlier
    if version in existing.versions:
        version = f"{version}-{content_hash[:8]}"
    if version in existing.versions:
        raise Conflict("这个版本号已被占用，请改 SKILL.md 里的 version")
    return "update", version


def _stored_security(value: Any) -> dict | None:
    """Only the normalized `/scan` shape is shown; older rows stored ClawHub's raw verify block."""
    return value if isinstance(value, dict) and isinstance(value.get("scanners"), list) else None


class PlatformSkillRepository:
    def __init__(self, dsn: str):
        self._dsn = dsn

    def upsert_download(self, *, owner: str, slug: str, display_name: str, summary: str, version: str, files: list[dict[str, str]], content_hash: str, security: dict, auto_publish: bool, source_url: str) -> dict:
        import psycopg
        from psycopg.types.json import Json
        status = "published" if auto_publish else "draft"
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            skill = conn.execute(
                "INSERT INTO platform_skill (external_owner, external_slug, display_name, summary, latest_external_version, latest_internal_version, published_version, status) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (source, external_owner, external_slug) DO UPDATE SET "
                "display_name=EXCLUDED.display_name, summary=EXCLUDED.summary, latest_external_version=EXCLUDED.latest_external_version RETURNING id",
                (owner, slug, display_name, summary, version, version, version if auto_publish else None, status),
            ).fetchone()
            skill_id = str(skill[0])
            existing = conn.execute(
                "SELECT id, content_hash, status FROM platform_skill_version WHERE platform_skill_id=%s AND version=%s FOR UPDATE",
                (skill_id, version),
            ).fetchone()
            if existing is not None:
                if existing[1] != content_hash:
                    conn.rollback()
                    raise Conflict("ClawHub returned different content for an existing skill version")
                version_id = str(existing[0])
                if auto_publish:
                    conn.execute("UPDATE platform_skill_version SET status='published', security=%s WHERE id=%s", (Json(security), existing[0]))
                    conn.execute("UPDATE platform_skill SET latest_internal_version=%s, published_version=%s, status='published' WHERE id=%s", (version, version, skill_id))
                conn.commit()
                return {"skill_id": skill_id, "version_id": version_id, "owner": owner, "slug": slug, "display_name": display_name, "summary": summary, "version": version, "content_hash": content_hash, "status": "published" if auto_publish else existing[2]}
            row = conn.execute(
                "INSERT INTO platform_skill_version (platform_skill_id, version, content_hash, files, security, source_url, status) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (skill_id, version, content_hash, Json(files), Json(security), source_url, status),
            ).fetchone()
            if auto_publish:
                conn.execute("UPDATE platform_skill SET latest_internal_version=%s, published_version=%s, status='published' WHERE id=%s", (version, version, skill_id))
            else:
                conn.execute("UPDATE platform_skill SET latest_internal_version=%s WHERE id=%s", (version, skill_id))
            conn.commit()
        return {"skill_id": skill_id, "version_id": str(row[0]), "owner": owner, "slug": slug, "display_name": display_name, "summary": summary, "version": version, "content_hash": content_hash, "status": status}

    def list_internal(self, *, status: str | None = None) -> list[dict]:
        import psycopg
        sql = (
            "SELECT s.id, s.external_owner, s.external_slug, s.display_name, s.summary, "
            "s.latest_external_version, s.latest_internal_version, s.published_version, s.status, "
            "latest.content_hash, published.content_hash, latest.status, latest.security, s.source "
            "FROM platform_skill s "
            "LEFT JOIN platform_skill_version latest ON latest.platform_skill_id=s.id AND latest.version=s.latest_internal_version "
            "LEFT JOIN platform_skill_version published ON published.platform_skill_id=s.id AND published.version=s.published_version"
        )
        args: list[Any] = []
        if status:
            sql += " WHERE s.status=%s"; args.append(status)
        sql += " ORDER BY s.display_name, s.external_owner, s.external_slug"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            rows = conn.execute(sql, args).fetchall()
        return [{"skill_id": str(r[0]), "owner": r[1], "slug": r[2], "display_name": r[3], "summary": r[4], "latest_external_version": r[5], "latest_internal_version": r[6], "published_version": r[7], "status": r[8], "latest_content_hash": r[9], "content_hash": r[10], "latest_version_status": r[11], "security": _stored_security(r[12]), "source": r[13]} for r in rows]

    def find_custom(self, *, name: str) -> CustomSkillState | None:
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return self._custom_state(conn, name=name, lock=False)

    @staticmethod
    def _custom_state(conn, *, name: str, lock: bool) -> CustomSkillState | None:
        row = conn.execute(
            "SELECT id, latest_internal_version FROM platform_skill WHERE source='custom' AND external_owner=%s AND external_slug=%s"
            + (" FOR UPDATE" if lock else ""),
            (CUSTOM_OWNER, name),
        ).fetchone()
        if row is None:
            return None
        versions = dict(conn.execute(
            "SELECT version, content_hash FROM platform_skill_version WHERE platform_skill_id=%s", (row[0],),
        ).fetchall())
        return CustomSkillState(str(row[0]), row[1], versions.get(row[1]) if row[1] else None, versions)

    def save_custom(self, *, name: str, description: str, files: list[dict[str, str]], content_hash: str,
                    declared_version: str, auto_publish: bool, source_url: str) -> dict:
        """Store a custom skill's files as a new immutable version (or report it unchanged)."""
        import psycopg
        from psycopg.types.json import Json
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            existing = self._custom_state(conn, name=name, lock=True)
            state, version = plan_custom_version(existing, content_hash=content_hash, declared=declared_version)
            if state == "same":
                conn.rollback()
                return {"skill_id": existing.skill_id, "name": name, "version": version, "status": "duplicate"}
            skill_id = existing.skill_id if existing else str(conn.execute(
                "INSERT INTO platform_skill (source, external_owner, external_slug, display_name, summary, status) "
                "VALUES ('custom', %s, %s, %s, %s, 'draft') RETURNING id",
                (CUSTOM_OWNER, name, name, description),
            ).fetchone()[0])
            if existing is None or version not in existing.versions:
                conn.execute(
                    "INSERT INTO platform_skill_version (platform_skill_id, version, content_hash, files, security, source_url, status) "
                    "VALUES (%s,%s,%s,%s,'{}'::jsonb,%s,%s)",
                    (skill_id, version, content_hash, Json(files), source_url, "published" if auto_publish else "draft"),
                )
            elif auto_publish:
                conn.execute("UPDATE platform_skill_version SET status='published' WHERE platform_skill_id=%s AND version=%s", (skill_id, version))
            if auto_publish:
                conn.execute(
                    "UPDATE platform_skill SET display_name=%s, summary=%s, latest_internal_version=%s, published_version=%s, status='published' WHERE id=%s",
                    (name, description, version, version, skill_id),
                )
            else:
                conn.execute("UPDATE platform_skill SET display_name=%s, summary=%s, latest_internal_version=%s WHERE id=%s",
                             (name, description, version, skill_id))
            conn.commit()
        return {"skill_id": skill_id, "name": name, "version": version,
                "status": "installed" if existing is None else "updated", "published": auto_publish}

    def get_latest_files(self, *, skill_id: str) -> dict:
        """The current (latest imported) version's files, for viewing or editing in the console."""
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            row = conn.execute(
                "SELECT s.source, s.display_name, s.summary, s.latest_internal_version, v.files "
                "FROM platform_skill s JOIN platform_skill_version v ON v.platform_skill_id=s.id AND v.version=s.latest_internal_version "
                "WHERE s.id=%s",
                (skill_id,),
            ).fetchone()
        if row is None:
            raise NotFound("platform skill not found")
        return {"skill_id": skill_id, "source": row[0], "display_name": row[1], "summary": row[2], "version": row[3],
                "files": [{"path": f["path"], "content": f["content"]} for f in (row[4] or [])]}

    def get_internal(self, *, skill_id: str) -> dict:
        rows = [row for row in self.list_internal() if row["skill_id"] == skill_id]
        if not rows:
            raise NotFound("platform skill not found")
        return rows[0]

    def set_status(self, *, skill_id: str, status: str) -> dict:
        import psycopg
        if status not in {"published", "unpublished"}:
            raise ValidationProblem("invalid platform skill status")
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            row = conn.execute(
                "SELECT id, latest_internal_version FROM platform_skill WHERE id=%s FOR UPDATE",
                (skill_id,),
            ).fetchone()
            if row is not None:
                conn.execute(
                    "UPDATE platform_skill SET status=%s, published_version=CASE WHEN %s='published' THEN latest_internal_version ELSE NULL END WHERE id=%s",
                    (status, status, skill_id),
                )
                if row[1]:
                    conn.execute("UPDATE platform_skill_version SET status=%s WHERE platform_skill_id=%s AND version=%s", ("published" if status == "published" else "draft", skill_id, row[1]))
                conn.commit()
        if row is None:
            raise NotFound("platform skill not found")
        return self.get_internal(skill_id=skill_id)

    def get_package(self, *, skill_id: str, version: str, published_only: bool = False) -> dict:
        import psycopg
        where = "s.id=%s AND v.version=%s"
        if published_only:
            where += " AND s.status='published' AND v.status='published'"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            row = conn.execute(
                "SELECT s.external_owner, s.external_slug, s.display_name, s.summary, v.content_hash, v.files, v.source_url "
                "FROM platform_skill s JOIN platform_skill_version v ON v.platform_skill_id=s.id WHERE " + where,
                (skill_id, version),
            ).fetchone()
        if row is None:
            raise NotFound("platform skill version not found")
        return {"owner": row[0], "slug": row[1], "display_name": row[2], "summary": row[3], "content_hash": row[4], "files": list(row[5] or []), "source_url": row[6], "version": version}

    def get_setting(self) -> bool:
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return bool(conn.execute("SELECT auto_publish_downloads FROM platform_skill_setting WHERE id=true").fetchone()[0])

    def set_setting(self, enabled: bool) -> bool:
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            conn.execute("UPDATE platform_skill_setting SET auto_publish_downloads=%s, updated_at=now() WHERE id=true", (enabled,))
        return enabled
