"""Operator-owned ClawHub import and internal platform skill versions."""

from __future__ import annotations

import hashlib
import io
import json
import stat
import time
import zipfile
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from shared.errors import Conflict, NotFound, TooManyRequests, ValidationProblem

MAX_ZIP_BYTES = 2 * 1024 * 1024
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_TEXT_BYTES = 1024 * 1024
MAX_FILES = 64


def _hash_files(files: list[dict[str, str]]) -> str:
    normalized = [(item["path"], item["content"]) for item in sorted(files, key=lambda x: x["path"])]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:16]


def _valid_path(path: str) -> bool:
    if not path or "\\" in path or path.startswith("/") or "//" in path:
        return False
    parts = path.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        return False
    return path == "SKILL.md" or (path.startswith("references/") and path.endswith(".md"))


def parse_skill_zip(raw: bytes) -> tuple[list[dict[str, str]], str]:
    if len(raw) > MAX_ZIP_BYTES:
        raise ValidationProblem("skill archive is too large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValidationProblem("ClawHub returned an invalid skill archive") from exc
    infos = archive.infolist()
    if len(infos) > MAX_FILES:
        raise ValidationProblem("skill archive contains too many files")
    files: list[dict[str, str]] = []
    total = 0
    seen: set[str] = set()
    for info in infos:
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValidationProblem("skill archive contains a symbolic link")
        if info.is_dir():
            if info.filename not in {"references/"}:
                raise ValidationProblem("skill archive contains an unsupported directory")
            continue
        if info.filename in {"_meta.json", "skill-card.md"}:
            continue
        if not _valid_path(info.filename) or info.filename in seen:
            raise ValidationProblem("skill archive contains an unsupported or unsafe file path")
        if info.file_size > MAX_FILE_BYTES:
            raise ValidationProblem("skill file is too large")
        total += info.file_size
        if total > MAX_TOTAL_TEXT_BYTES:
            raise ValidationProblem("skill archive text is too large")
        try:
            content = archive.read(info).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationProblem("skill files must be UTF-8 text") from exc
        seen.add(info.filename)
        files.append({"path": info.filename, "content": content})
    if "SKILL.md" not in seen:
        raise ValidationProblem("skill archive must contain SKILL.md")
    return files, _hash_files(files)


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

    def browse(self, *, cursor: str | None = None, limit: int = 20, sort: str = "updated") -> tuple[list[ExternalSkill], str | None]:
        params: dict[str, Any] = {"family": "skill", "limit": min(max(limit, 1), 100), "sort": sort, "nonSuspiciousOnly": "true"}
        if cursor:
            params["cursor"] = cursor
        body = self._json("/api/v1/packages", params)
        return [self._from_package(item) for item in body.get("items", []) if item.get("family") == "skill"], body.get("nextCursor")

    def search(self, query: str, *, limit: int = 20) -> list[ExternalSkill]:
        body = self._json("/api/v1/search", {"q": query, "limit": min(max(limit, 1), 100), "nonSuspiciousOnly": "true"})
        return [self._from_search(item) for item in body.get("results", [])]

    def detail(self, *, owner: str, slug: str) -> dict[str, Any]:
        return self._json(f"/api/v1/skills/{quote(slug, safe='')}", {"ownerHandle": owner})

    def verify(self, *, owner: str, slug: str, version: str) -> dict[str, Any]:
        return self._json(f"/api/v1/skills/{quote(slug, safe='')}/verify", {"ownerHandle": owner, "version": version}, cache=False)

    def download(self, *, owner: str, slug: str, version: str) -> bytes:
        chunks: list[bytes] = []
        total = 0
        with self._client.stream("GET", "/api/v1/download", params={"ownerHandle": owner, "slug": slug, "version": version}) as response:
            if response.status_code == 429:
                raise TooManyRequests("ClawHub rate limit reached; retry later")
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
            "latest.content_hash, published.content_hash, latest.status "
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
        return [{"skill_id": str(r[0]), "owner": r[1], "slug": r[2], "display_name": r[3], "summary": r[4], "latest_external_version": r[5], "latest_internal_version": r[6], "published_version": r[7], "status": r[8], "latest_content_hash": r[9], "content_hash": r[10], "latest_version_status": r[11]} for r in rows]

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
