"""Collect a skill from an admin-supplied source and read its SKILL.md.

Shared by the Manager enterprise import (design 2026-11-20 §4.3) and the Operator custom platform skills
(§4.7). Sources mirror the desktop's local import (`server/agent_service/src/custom-skills.ts`):

* `folder` / `zip` / `file` (one .md) — uploaded bytes;
* `text` — a pasted SKILL.md;
* `editor` — the files written in the console's SKILL.md editor (same as an uploaded folder);
* `url` — a public https address (GitHub repo / sub-folder / blob, `.zip`, `.md`) fetched through
  `shared.net_guard` (https only, public addresses pinned, 20 s, 10 MiB).

ClawHub is not handled here: the Manager adds it on top (Operator has its own ClawHub market).

A skill is a folder with SKILL.md — frontmatter `name` (lowercase, digits, single hyphens, ≤ 64) and
`description` (when to use it, ≤ 1024), then the instructions — plus optional scripts / references / assets.
`read_skill` checks exactly that and nothing more. Nothing is executed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import quote, urlsplit

import yaml

from .errors import AppError, ValidationProblem
from .net_guard import Blocked, Fetch, FetchFailed, get, pinned_fetch
from .skill_import import (
    MAX_ARCHIVE_BYTES,
    SkippedFile,
    entries_at_root,
    normalize_files,
    unzip_entries,
)
from .skill_package import catalog_package, validate_skill_frontmatter

Source = Literal["folder", "zip", "file", "text", "editor", "url"]
UPLOAD_SOURCES: tuple[str, ...] = ("folder", "zip", "file", "editor")
SOURCE_LABELS: dict[str, str] = {
    "folder": "上传的文件夹", "zip": "上传的压缩包", "file": "上传的 .md 文件", "text": "粘贴的 SKILL.md",
    "editor": "在线编辑",
}
DOWNLOAD_TIMEOUT_S = 20.0
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
# Same character set as the signed package's version segment; a leading dot is never a version.
VERSION_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$")


class SkillSourceUnavailable(AppError):
    status, code, title = 502, "skill_source_unavailable", "Skill source unavailable"


@dataclass
class Origin:
    kind: str
    label: str
    url: str = ""

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "label": self.label, **({"url": self.url} if self.url else {})}


@dataclass
class Gathered:
    entries: list[tuple[str, bytes]]
    origin: Origin
    clawhub: dict[str, Any] | None = None


@dataclass
class SkillRead:
    """One skill root after reading SKILL.md. `ok=False` carries a reason the admin can act on."""

    root: str
    ok: bool
    reason: str = ""
    name: str = ""
    description: str = ""
    declared_version: str = ""
    content_hash: str = ""
    files: list[dict[str, str]] = field(default_factory=list)
    skipped: list[SkippedFile] = field(default_factory=list)


class SourceGatherer:
    """Turns an import request into raw `(path, bytes)` entries; remote fetches go through `net_guard`."""

    def __init__(self, fetch: Fetch | None = None):
        self._fetch = fetch

    def gather(self, source: str, *, entries: list[tuple[str, bytes]] | None = None, text: str = "", url: str = "") -> Gathered:
        if source in UPLOAD_SOURCES:
            if not entries:
                raise ValidationProblem("没有上传文件")
            if source == "zip":
                if len(entries) != 1:
                    raise ValidationProblem("一次上传一个压缩包")
                entries = unzip_entries(entries[0][1])
            elif source == "file":
                if len(entries) != 1 or not entries[0][0].lower().endswith(".md"):
                    raise ValidationProblem("请上传一个 .md 文件")
                entries = [("SKILL.md", entries[0][1])]
            return Gathered(list(entries), Origin(source, SOURCE_LABELS[source]))
        if source == "text":
            if not text.strip():
                raise ValidationProblem("没有粘贴 SKILL.md 内容")
            return Gathered([("SKILL.md", text.encode("utf-8"))], Origin("text", SOURCE_LABELS["text"]))
        if source == "url":
            if not url.strip():
                raise ValidationProblem("没有填写网址")
            return self.gather_url(url.strip())
        raise ValidationProblem(f"不支持的来源：{source}")

    def get(self, url: str, *, allow_status: tuple[int, ...] = (200,)) -> tuple[int, bytes]:
        fetch = self._fetch or pinned_fetch(max_bytes=MAX_ARCHIVE_BYTES)
        try:
            status, _headers, body = get(url, fetch=fetch, timeout_s=DOWNLOAD_TIMEOUT_S, allow_status=allow_status)
        except Blocked as exc:
            raise ValidationProblem(str(exc)) from exc
        except FetchFailed as exc:
            raise SkillSourceUnavailable(f"{exc}（{urlsplit(url).netloc}）") from exc
        return status, body

    def gather_url(self, raw: str) -> Gathered:
        url = urlsplit(raw)
        if url.scheme != "https" or not url.netloc:
            raise ValidationProblem("只支持 https 网址")
        origin = Origin("url", raw, raw)
        github = github_parts(url.netloc, url.path)
        if github is not None:
            owner, repo, kind, ref, rest = github
            if kind == "blob":
                return Gathered([("SKILL.md", self.get(f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{rest}")[1])], origin)
            branch = ref or "main"
            files = unzip_entries(self.get(f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{quote(branch)}")[1])
            if kind != "tree" or not rest:
                return Gathered(files, origin)
            nested = entries_at_root(files, f"{repo}-{branch.replace('/', '-')}/{rest}")
            if not nested:
                raise ValidationProblem(f"压缩包里找不到子目录：{rest}")
            return Gathered(nested, origin)
        lower = url.path.lower()
        if lower.endswith(".zip"):
            return Gathered(unzip_entries(self.get(raw)[1]), origin)
        if lower.endswith(".md"):
            return Gathered([("SKILL.md", self.get(raw)[1])], origin)
        raise ValidationProblem("网址只能是 GitHub 链接、以 .md 结尾的文件，或以 .zip 结尾的压缩包")


def read_skill(entries: list[tuple[str, bytes]], root: str) -> SkillRead:
    """Normalize one skill root and check its SKILL.md the way an Agent Skills loader would."""
    normalized = normalize_files(entries_at_root(entries, root))
    item = SkillRead(root=root, ok=False, files=normalized.files, skipped=normalized.skipped)
    skill_md = next((f["content"] for f in normalized.files if f["path"] == "SKILL.md"), None)
    if skill_md is None:
        item.reason = "SKILL.md 不是 UTF-8 文本，或路径不受支持"
        return item
    try:
        validate_skill_frontmatter(skill_md)
        meta = frontmatter(skill_md)
    except (ValueError, yaml.YAMLError):
        item.reason = "SKILL.md 开头的元数据（--- 之间）格式不对，或缺少 description"
        return item
    name = str(meta.get("name") or "").strip()
    item.description = str(meta.get("description") or "").strip()
    if not name:
        item.reason = "SKILL.md 缺少 name"
        return item
    item.name = name
    if len(name) > 64 or not NAME_RE.fullmatch(name):
        item.reason = "name 只能用小写字母、数字和单个连字符，不超过 64 个字符"
        return item
    try:
        package = catalog_package(skill_id=name, version="0", files=normalized.files, display_name=name)
    except (ValueError, TypeError, KeyError) as exc:
        item.reason = f"技能包不符合规则：{exc}"
        return item
    item.content_hash = package.content_hash
    declared = str(meta.get("version") or "").strip()
    item.declared_version = declared if VERSION_RE.fullmatch(declared) else ""
    item.ok = True
    return item


def frontmatter(text: str) -> dict[str, Any]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.DOTALL)
    meta = yaml.safe_load(match.group(1)) if match else None
    return meta if isinstance(meta, dict) else {}


def github_parts(host: str, path: str) -> tuple[str, str, str, str, str] | None:
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
