"""Signed text skill package contract checks."""

import base64
import hashlib

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from manager_service.skill_signing import SkillPackageSigner
from shared.contracts.skill import SkillFile, SkillPackage, canonical_skill_package_bytes


def _package():
    content = "# Review\n"
    file = SkillFile(path="SKILL.md", content=content, content_hash=hashlib.sha256(content.encode()).hexdigest()[:16])
    return SkillPackage(skill_id="review", version="1", files=[file], content_hash="").with_computed_hash()


def test_manager_signs_canonical_tenant_bound_package_with_dedicated_ed25519_key():
    private = Ed25519PrivateKey.generate()
    envelope = SkillPackageSigner(private, "skills-2026").sign(_package(), tenant_id="tenant-a", member_id="member-a")
    public = private.public_key()
    public.verify(base64.b64decode(envelope.signature), canonical_skill_package_bytes(envelope.package, "tenant-a", "member-a"))
    assert envelope.key_id == "skills-2026"
    assert envelope.algorithm == "Ed25519"
    assert envelope.tenant_id == "tenant-a"
    assert envelope.member_id == "member-a"


def test_python_package_hash_fixture_matches_node_order_for_mixed_case_paths():
    files = [
        SkillFile(path="references/a.md", content="a\n", content_hash=hashlib.sha256(b"a\n").hexdigest()[:16]),
        SkillFile(path="SKILL.md", content="# Review\n", content_hash=hashlib.sha256(b"# Review\n").hexdigest()[:16]),
        SkillFile(path="references/B.md", content="B\n", content_hash=hashlib.sha256(b"B\n").hexdigest()[:16]),
    ]
    package = SkillPackage(skill_id="review", version="mixed", files=files, content_hash="").with_computed_hash()
    assert package.content_hash == "24eacde1fda51f39"


def test_skill_package_rejects_backslash_duplicate_and_hash_tampering():
    content_hash = hashlib.sha256(b"x").hexdigest()[:16]
    with pytest.raises(ValueError): SkillFile(path="references\\x.md", content="x", content_hash=content_hash)
    files = [SkillFile(path="SKILL.md", content="x", content_hash=content_hash)]
    package = SkillPackage(skill_id="x", version="1", files=files, content_hash="").with_computed_hash()
    with pytest.raises(ValueError): SkillPackage(skill_id="x", version="1", files=files + files, content_hash=package.content_hash)
    with pytest.raises(ValueError): SkillPackage(skill_id="x", version="1", files=files, content_hash="0000000000000000")
