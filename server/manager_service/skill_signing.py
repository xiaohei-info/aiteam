"""Dedicated Ed25519 signing and public key rotation for Manager → Agent skills."""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Iterable
from datetime import datetime, timezone

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_der_private_key,
)

from shared.contracts.skill import (
    SignedSkillPackage,
    SkillPackage,
    SkillSigningKeyMetadata,
    canonical_skill_package_bytes,
)


class SkillSigningConfigurationError(RuntimeError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: str | None, *, name: str) -> str | None:
    if value is None or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise SkillSigningConfigurationError(f"invalid {name}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _is_usable(metadata: SkillSigningKeyMetadata, now: datetime) -> bool:
    if metadata.status in {"revoked", "expired"}:
        return False
    if metadata.not_before and datetime.fromisoformat(metadata.not_before.replace("Z", "+00:00")) > now:
        return False
    if metadata.expires_at and datetime.fromisoformat(metadata.expires_at.replace("Z", "+00:00")) <= now:
        return False
    return True


class SkillPackageSigner:
    """Sign with the current dedicated Ed25519 key and publish public overlap metadata.

    The constructor accepts a current key and an optional next key so tests and
    explicit deployments can build a rotation without relying on process env.
    ``public_metadata`` never serializes either private key.
    """

    def __init__(
        self,
        private_key: Ed25519PrivateKey,
        key_id: str,
        *,
        next_private_key: Ed25519PrivateKey | None = None,
        next_key_id: str | None = None,
        current_not_before: str | None = None,
        current_expires_at: str | None = None,
        next_not_before: str | None = None,
        next_expires_at: str | None = None,
        revoked_key_ids: Iterable[str] = (),
        revoked_keys: Iterable[SkillSigningKeyMetadata] = (),
    ):
        if not key_id:
            raise SkillSigningConfigurationError("current skill signing key id is required")
        if (next_private_key is None) != (next_key_id is None):
            raise SkillSigningConfigurationError("next skill signing key and key id must be configured together")
        if next_key_id == key_id:
            raise SkillSigningConfigurationError("current and next skill signing key ids must differ")
        if next_private_key is not None and next_private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw) == private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw):
            raise SkillSigningConfigurationError("current and next skill signing keys must differ")

        current = SkillSigningKeyMetadata(
            key_id=key_id,
            public_key=self._public_key(private_key),
            status="current",
            not_before=_iso(current_not_before, name="current key not_before"),
            expires_at=_iso(current_expires_at, name="current key expires_at"),
        )
        next_metadata = None
        if next_private_key is not None and next_key_id is not None:
            next_metadata = SkillSigningKeyMetadata(
                key_id=next_key_id,
                public_key=self._public_key(next_private_key),
                status="next",
                not_before=_iso(next_not_before, name="next key not_before"),
                expires_at=_iso(next_expires_at, name="next key expires_at"),
            )

        revoked: list[SkillSigningKeyMetadata] = []
        revoked_at = _now().isoformat().replace("+00:00", "Z")
        for key_id_value in revoked_key_ids:
            if not key_id_value or key_id_value in {key_id, next_key_id}:
                raise SkillSigningConfigurationError("invalid or active revoked skill signing key id")
            revoked.append(SkillSigningKeyMetadata(key_id=key_id_value, status="revoked", revoked_at=revoked_at))
        for metadata in revoked_keys:
            if metadata.status != "revoked":
                raise SkillSigningConfigurationError("revoked skill signing metadata must have revoked status")
            if metadata.key_id in {key_id, next_key_id}:
                raise SkillSigningConfigurationError("active skill signing key cannot be revoked")
            revoked.append(metadata)

        ids = [current.key_id, *( [next_metadata.key_id] if next_metadata else []), *(item.key_id for item in revoked)]
        if len(ids) != len(set(ids)):
            raise SkillSigningConfigurationError("duplicate skill signing key id")
        self._private_key = private_key
        self._current = current
        self._next = next_metadata
        self._revoked = tuple(revoked)
        self.key_id = current.key_id

    @staticmethod
    def _public_key(private_key: Ed25519PrivateKey) -> str:
        return base64.b64encode(private_key.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)).decode("ascii")

    @staticmethod
    def _load_private(encoded: str, env_name: str) -> Ed25519PrivateKey:
        try:
            raw = base64.b64decode(encoded, validate=True)
            key = load_der_private_key(raw, password=None)
        except Exception as exc:  # pragma: no cover - cryptography supplies varied errors
            raise SkillSigningConfigurationError(f"invalid {env_name}") from exc
        if not isinstance(key, Ed25519PrivateKey):
            raise SkillSigningConfigurationError("skill signing key must be Ed25519 PKCS8 DER")
        return key

    @classmethod
    def from_env(cls) -> "SkillPackageSigner | None":
        """Load dedicated current/next private keys; never JWT or symmetric material."""
        encoded = os.environ.get("AITEAM_SKILL_SIGNING_CURRENT_PRIVATE_KEY") or os.environ.get("AITEAM_SKILL_SIGNING_PRIVATE_KEY")
        key_id = os.environ.get("AITEAM_SKILL_SIGNING_CURRENT_KEY_ID") or os.environ.get("AITEAM_SKILL_SIGNING_KEY_ID")
        next_encoded = os.environ.get("AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY")
        next_key_id = os.environ.get("AITEAM_SKILL_SIGNING_NEXT_KEY_ID")
        if not encoded and not key_id and not next_encoded and not next_key_id:
            return None
        if not encoded or not key_id:
            raise SkillSigningConfigurationError("current skill signing private key and key id are required")
        if (next_encoded is None) != (next_key_id is None):
            raise SkillSigningConfigurationError("next skill signing private key and key id must be configured together")
        current = cls._load_private(encoded, "AITEAM_SKILL_SIGNING_PRIVATE_KEY")
        next_key = cls._load_private(next_encoded, "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY") if next_encoded else None
        revoked_ids = tuple(item.strip() for item in os.environ.get("AITEAM_SKILL_SIGNING_REVOKED_KEY_IDS", "").split(",") if item.strip())
        revoked_keys: list[SkillSigningKeyMetadata] = []
        raw_revoked = os.environ.get("AITEAM_SKILL_SIGNING_REVOKED_KEYS_JSON")
        if raw_revoked:
            try:
                values = json.loads(raw_revoked)
                if not isinstance(values, list):
                    raise ValueError("expected list")
                revoked_keys = [SkillSigningKeyMetadata.model_validate(value) for value in values]
            except Exception as exc:
                raise SkillSigningConfigurationError("invalid AITEAM_SKILL_SIGNING_REVOKED_KEYS_JSON") from exc
        return cls(
            current,
            key_id,
            next_private_key=next_key,
            next_key_id=next_key_id,
            current_not_before=os.environ.get("AITEAM_SKILL_SIGNING_CURRENT_NOT_BEFORE"),
            current_expires_at=os.environ.get("AITEAM_SKILL_SIGNING_CURRENT_EXPIRES_AT"),
            next_not_before=os.environ.get("AITEAM_SKILL_SIGNING_NEXT_NOT_BEFORE"),
            next_expires_at=os.environ.get("AITEAM_SKILL_SIGNING_NEXT_EXPIRES_AT"),
            revoked_key_ids=revoked_ids,
            revoked_keys=revoked_keys,
        )

    @property
    def has_next(self) -> bool:
        return self._next is not None

    def public_metadata(self) -> list[SkillSigningKeyMetadata]:
        """Return current/next overlap plus explicit revocations, public material only."""
        return [self._current, *([self._next] if self._next else []), *self._revoked]

    # Named alias for callers that model the response as a public key set.
    public_keys = public_metadata

    def sign(self, package: SkillPackage, *, tenant_id: str, member_id: str) -> SignedSkillPackage:
        if not package.content_hash or package.content_hash != package.compute_content_hash():
            raise SkillSigningConfigurationError("cannot sign a package with an invalid content hash")
        if not tenant_id or not member_id:
            raise SkillSigningConfigurationError("skill signing scope is required")
        if not _is_usable(self._current, _now()):
            raise SkillSigningConfigurationError("current skill signing key is not usable")
        signature = self._private_key.sign(canonical_skill_package_bytes(package, tenant_id, member_id))
        return SignedSkillPackage(
            package=package,
            tenant_id=tenant_id,
            member_id=member_id,
            key_id=self._current.key_id,
            algorithm="Ed25519",
            signature=base64.b64encode(signature).decode("ascii"),
        )

    def private_der(self) -> bytes:
        """Only useful for explicit tests; signing code never serializes this value."""
        return self._private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
