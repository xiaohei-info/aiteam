"""Dedicated Ed25519 signing for Manager → Agent text skill packages."""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, load_der_private_key

from shared.contracts.skill import SignedSkillPackage, SkillPackage, canonical_skill_package_bytes


class SkillSigningConfigurationError(RuntimeError):
    pass


class SkillPackageSigner:
    """Load only the dedicated DER PKCS8 key; JWT/HMAC keys are never accepted."""

    def __init__(self, private_key: Ed25519PrivateKey, key_id: str):
        self._private_key = private_key
        self.key_id = key_id

    @classmethod
    def from_env(cls) -> "SkillPackageSigner | None":
        encoded = os.environ.get("AITEAM_SKILL_SIGNING_PRIVATE_KEY")
        key_id = os.environ.get("AITEAM_SKILL_SIGNING_KEY_ID")
        if not encoded or not key_id:
            return None
        try:
            raw = base64.b64decode(encoded, validate=True)
            key = load_der_private_key(raw, password=None)
        except Exception as exc:  # pragma: no cover - cryptography supplies varied errors
            raise SkillSigningConfigurationError("invalid AITEAM_SKILL_SIGNING_PRIVATE_KEY") from exc
        if not isinstance(key, Ed25519PrivateKey):
            raise SkillSigningConfigurationError("skill signing key must be Ed25519 PKCS8 DER")
        return cls(key, key_id)

    def sign(self, package: SkillPackage, *, tenant_id: str, member_id: str) -> SignedSkillPackage:
        if not package.content_hash or package.content_hash != package.compute_content_hash():
            raise SkillSigningConfigurationError("cannot sign a package with an invalid content hash")
        if not tenant_id or not member_id:
            raise SkillSigningConfigurationError("skill signing scope is required")
        signature = self._private_key.sign(canonical_skill_package_bytes(package, tenant_id, member_id))
        return SignedSkillPackage(
            package=package,
            tenant_id=tenant_id,
            member_id=member_id,
            key_id=self.key_id,
            algorithm="Ed25519",
            signature=base64.b64encode(signature).decode("ascii"),
        )

    def private_der(self) -> bytes:
        """Only useful for explicit tests; signing code never serializes this value."""
        return self._private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
