"""Turn untrusted skill sources (zip archives, uploaded folders) into distributable text files.

Shared by the Operator ClawHub import and the Manager custom import. The rules mirror the desktop's local
import (`server/agent_service/src/custom-skills.ts`):

* `.git/`, `__MACOSX/` and `.DS_Store` are dropped silently (packaging noise);
* platform hook folders (`hooks/<platform>/…`, e.g. OpenClaw) are skipped and reported;
* binary (non UTF-8) files are skipped and reported — signed packages carry text only;
* paths the shared contract cannot carry (spaces, non-ASCII, dot segments, too deep) are skipped and reported;
* nothing is executed or interpreted here.
"""

from __future__ import annotations

import io
import stat
import zipfile
from dataclasses import dataclass, field

from .contracts.skill import (
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    MAX_SKILL_TOTAL_BYTES,
    normalize_skill_file_path,
)
from .errors import ValidationProblem

# A downloaded archive may carry noise beyond the package itself (skipped entries, directories).
MAX_ARCHIVE_BYTES = MAX_SKILL_TOTAL_BYTES
MAX_ARCHIVE_ENTRIES = MAX_SKILL_FILES * 4

_NOISE_DIRS = frozenset({".git", "__MACOSX"})
_NOISE_FILES = frozenset({".DS_Store"})


@dataclass(frozen=True)
class SkippedFile:
    path: str
    reason: str  # "platform_hook" | "binary" | "unsupported_path"


@dataclass
class NormalizedFiles:
    files: list[dict[str, str]] = field(default_factory=list)  # [{"path", "content"}]
    skipped: list[SkippedFile] = field(default_factory=list)


def is_platform_hook_path(path: str) -> bool:
    """`hooks/<platform>/…` only means something on that platform; Pi has no equivalent."""
    parts = path.split("/")
    return len(parts) >= 3 and parts[0] == "hooks" and bool(parts[1])


def _is_noise(path: str) -> bool:
    parts = path.split("/")
    return any(part in _NOISE_DIRS for part in parts[:-1]) or parts[-1] in _NOISE_FILES


def normalize_files(entries: list[tuple[str, bytes]]) -> NormalizedFiles:
    """Classify raw `(path, bytes)` entries into distributable text files and reported skips.

    Paths use `/`; a leading `./` is tolerated. Raises when the kept files exceed the package limits —
    the caller decides which skill root to keep before calling this when a source holds several skills.
    """
    result = NormalizedFiles()
    seen: set[str] = set()
    total = 0
    for raw_path, content in entries:
        path = raw_path.replace("\\", "/").removeprefix("./")
        if not path or path.endswith("/") or _is_noise(path):
            continue
        if is_platform_hook_path(path):
            result.skipped.append(SkippedFile(path, "platform_hook"))
            continue
        try:
            normalize_skill_file_path(path)
        except ValueError:
            result.skipped.append(SkippedFile(path, "unsupported_path"))
            continue
        if b"\x00" in content:
            result.skipped.append(SkippedFile(path, "binary"))
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            result.skipped.append(SkippedFile(path, "binary"))
            continue
        if path in seen:
            raise ValidationProblem(f"skill package contains a duplicate path: {path}")
        if len(content) > MAX_SKILL_FILE_BYTES:
            raise ValidationProblem(f"skill file is too large: {path}")
        total += len(content)
        if total > MAX_SKILL_TOTAL_BYTES:
            raise ValidationProblem("skill package is too large")
        seen.add(path)
        result.files.append({"path": path, "content": text})
    if len(result.files) > MAX_SKILL_FILES:
        raise ValidationProblem("skill package contains too many files")
    result.files.sort(key=lambda item: item["path"])
    result.skipped.sort(key=lambda item: item.path)
    return result


def unzip_entries(raw: bytes) -> list[tuple[str, bytes]]:
    """Read a zip archive defensively: size/entry caps checked before inflating, no links, no traversal."""
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValidationProblem("skill archive is too large")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ValidationProblem("skill archive is not a valid zip file") from exc
    infos = [info for info in archive.infolist() if not info.is_dir()]
    if len(infos) > MAX_ARCHIVE_ENTRIES:
        raise ValidationProblem("skill archive contains too many entries")
    declared = 0
    for info in infos:
        declared += info.file_size
        if declared > MAX_ARCHIVE_BYTES:
            raise ValidationProblem("skill archive is too large once extracted")
    entries: list[tuple[str, bytes]] = []
    actual = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValidationProblem("skill archive contains a symbolic link")
        if name.startswith("/") or any(part == ".." for part in name.split("/")):
            raise ValidationProblem("skill archive contains an unsafe path")
        # The header size may lie; read at most one byte past the cap to detect it.
        with archive.open(info) as handle:
            content = handle.read(MAX_ARCHIVE_BYTES - actual + 1)
        actual += len(content)
        if actual > MAX_ARCHIVE_BYTES:
            raise ValidationProblem("skill archive is too large once extracted")
        entries.append((name, content))
    return entries


def skill_roots(entries: list[tuple[str, bytes]]) -> list[str]:
    """Every directory that directly holds a SKILL.md ("" = archive root), sorted."""
    roots: set[str] = set()
    for raw_path, _ in entries:
        path = raw_path.replace("\\", "/").removeprefix("./")
        if _is_noise(path):
            continue
        parts = path.split("/")
        if parts[-1] == "SKILL.md":
            roots.add("/".join(parts[:-1]))
    return sorted(roots)


def entries_at_root(entries: list[tuple[str, bytes]], root: str) -> list[tuple[str, bytes]]:
    """Entries under `root`, re-based so the root's SKILL.md becomes `SKILL.md`."""
    if not root:
        return list(entries)
    prefix = root.rstrip("/") + "/"
    out: list[tuple[str, bytes]] = []
    for raw_path, content in entries:
        path = raw_path.replace("\\", "/").removeprefix("./")
        if path.startswith(prefix):
            out.append((path[len(prefix):], content))
    return out
