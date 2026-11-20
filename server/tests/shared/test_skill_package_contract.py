"""Widened signed skill package contract (design 2026-11-20 §4.1).

The JSON fixture is shared with `server/agent_service/src/skills.test.ts`: Python produces the signed
package, Node verifies it, and both sides run the same accepted/rejected path cases.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import stat
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from shared.contracts.skill import (
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    MAX_SKILL_TOTAL_BYTES,
    SignedSkillPackage,
    SkillFile,
    SkillPackage,
    canonical_skill_package_bytes,
    derive_file_hash,
    normalize_skill_file_path,
)
from shared.errors import ValidationProblem
from shared.skill_import import entries_at_root, normalize_files, skill_roots, unzip_entries

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures" / "skill_package_contract.json").read_text(encoding="utf-8"))


def _file(path: str, content: str) -> SkillFile:
    return SkillFile(path=path, content=content, content_hash=derive_file_hash(content))


def _package(files: list[SkillFile]) -> SkillPackage:
    return SkillPackage(skill_id="s", version="1", files=files, content_hash="").with_computed_hash()


@pytest.mark.parametrize("path", FIXTURE["accepted_paths"])
def test_accepted_paths(path):
    assert normalize_skill_file_path(path) == path


@pytest.mark.parametrize("path", FIXTURE["rejected_paths"])
def test_rejected_paths(path):
    with pytest.raises(ValueError):
        normalize_skill_file_path(path)


def test_python_signature_matches_fixture_that_node_verifies():
    signed = SignedSkillPackage.model_validate(FIXTURE["signed"])
    key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    signature = base64.b64encode(key.sign(canonical_skill_package_bytes(signed.package, signed.tenant_id, signed.member_id))).decode()
    assert signature == signed.signature
    assert signed.package.compute_content_hash() == signed.package.content_hash
    paths = {file.path for file in signed.package.files}
    assert {"scripts/extract-skill.sh", "assets/schema.json", "csv.md"} <= paths


def test_legacy_text_only_hash_is_unchanged():
    files = [_file("references/a.md", "a\n"), _file("SKILL.md", "# Review\n"), _file("references/B.md", "B\n")]
    package = SkillPackage(skill_id="review", version="mixed", files=files, content_hash="").with_computed_hash()
    assert package.content_hash == "24eacde1fda51f39"


def test_package_limits():
    skill = _file("SKILL.md", "x")
    _package([skill] + [_file(f"f{i}.md", "x") for i in range(MAX_SKILL_FILES - 1)])
    with pytest.raises(ValueError):
        _package([skill] + [_file(f"f{i}.md", "x") for i in range(MAX_SKILL_FILES)])
    with pytest.raises(ValueError):
        _package([skill, _file("big.txt", "x" * (MAX_SKILL_FILE_BYTES + 1))])
    chunk = "x" * (MAX_SKILL_FILE_BYTES - 1)
    with pytest.raises(ValueError):
        _package([skill, _file("a.txt", chunk), _file("b.txt", chunk), _file("c.txt", "x" * 3)])
    assert MAX_SKILL_TOTAL_BYTES == 2 * MAX_SKILL_FILE_BYTES


def test_normalize_skips_hooks_binaries_and_unsupported_paths():
    result = normalize_files([
        ("SKILL.md", b"---\nname: a\ndescription: d\n---\n"),
        ("scripts/run.sh", b"#!/bin/sh\n"),
        ("hooks/openclaw/handler.js", b"x"),
        ("assets/logo.png", b"\x89PNG\r\n\x1a\n\x00\x00"),
        ("assets/latin1.txt", "caf\xe9".encode("latin-1")),
        ("docs/has space.md", b"x"),
        (".env", b"SECRET=1"),
        (".git/config", b"x"),
        ("__MACOSX/._SKILL.md", b"x"),
        ("sub/.DS_Store", b"x"),
        ("./README.md", b"read me"),
    ])
    assert [f["path"] for f in result.files] == ["README.md", "SKILL.md", "scripts/run.sh"]
    assert [(s.path, s.reason) for s in result.skipped] == [
        (".env", "unsupported_path"),
        ("assets/latin1.txt", "binary"),
        ("assets/logo.png", "binary"),
        ("docs/has space.md", "unsupported_path"),
        ("hooks/openclaw/handler.js", "platform_hook"),
    ]


def test_normalize_rejects_oversized_and_duplicates():
    with pytest.raises(ValidationProblem):
        normalize_files([("SKILL.md", b"x"), ("big.txt", b"x" * (MAX_SKILL_FILE_BYTES + 1))])
    with pytest.raises(ValidationProblem):
        normalize_files([("SKILL.md", b"x"), ("./SKILL.md", b"y")])


def _zip(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/etc/passwd")
    return buffer.getvalue()


def test_unzip_roots_and_rebase():
    raw = _zip({"pack/a/SKILL.md": b"A", "pack/a/scripts/x.sh": b"x", "pack/b/SKILL.md": b"B", "pack/README.md": b"r"})
    entries = unzip_entries(raw)
    assert skill_roots(entries) == ["pack/a", "pack/b"]
    assert sorted(path for path, _ in entries_at_root(entries, "pack/a")) == ["SKILL.md", "scripts/x.sh"]


def test_unzip_rejects_links_traversal_and_bombs():
    with pytest.raises(ValidationProblem):
        unzip_entries(_zip({"SKILL.md": b"x"}, symlink="link"))
    with pytest.raises(ValidationProblem):
        unzip_entries(_zip({"../evil.md": b"x"}))
    with pytest.raises(ValidationProblem):
        unzip_entries(b"not a zip")
    big = b"0" * (MAX_SKILL_TOTAL_BYTES + 1)  # compresses to a few KiB
    with pytest.raises(ValidationProblem):
        unzip_entries(_zip({"SKILL.md": b"x", "bomb.txt": big}))


def test_sha16_helper_unchanged():
    assert derive_file_hash("a\n") == hashlib.sha256(b"a\n").hexdigest()[:16]
