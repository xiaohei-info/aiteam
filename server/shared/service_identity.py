"""Short-lived signed service identity primitives.

This module is intentionally separate from ``shared.auth`` user JWTs.  It
provides the narrow service-to-service assertion used by the control-plane
cross-tier calls:

* RS256 only, with a locally configured ``kid`` -> public-key trust map;
* required issuer, subject, audience, purpose, deployment, time window and
  unique ``jti`` claims;
* a maximum 60 second lifetime and bounded clock skew;
* request path/body binding and an enterprise/tenant scope carried by the
  assertion; and
* a bounded process-local replay cache for the short-lived assertion.

The trust map is deployment configuration, not an enterprise registry.  This
module never invents enterprise-to-Manager mappings or discovers keys from a
URL/header.  In production, missing trust metadata is a hard failure.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from shared.contracts.service_identity import ServicePrincipal
from shared.errors import Forbidden, Unauthorized

SERVICE_PURPOSE = "service"
SERVICE_ASSERTION_ALGORITHM = "RS256"
DEFAULT_SERVICE_ASSERTION_TTL_SECONDS = 30
MAX_ASSERTION_TTL_SECONDS = 60
MAX_CLOCK_SKEW_SECONDS = 30
MIN_RSA_KEY_SIZE = 2048

_FORBIDDEN_JWT_HEADERS = frozenset({"jku", "jwk", "x5u", "x5c"})
_REQUIRED_CLAIMS = ("iss", "sub", "aud", "purpose", "deployment_id", "iat", "nbf", "exp", "jti")
_ALLOWED_CLAIMS = frozenset(
    (*_REQUIRED_CLAIMS, "enterprise_id", "tenant_id", "scope", "path", "body_sha256", "origin", "capability", "idempotency_key")
)


def canonical_json_bytes(value: Any) -> bytes:
    """Return the deterministic JSON bytes bound into a service assertion."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def body_sha256(body: bytes | None) -> str | None:
    """Hash a request body, omitting the claim for body-less requests."""

    if not body:
        return None
    return hashlib.sha256(body).hexdigest()


def request_target(path: str, query: str = "") -> str:
    """Canonical path+query form used by both signer and verifier."""

    target = path or "/"
    if not target.startswith("/"):
        target = "/" + target
    if query:
        return f"{target}?{query}"
    return target


def canonical_origin(value: str, *, require_https: bool = False) -> str:
    """Validate and normalize an origin without accepting redirect/userinfo data."""

    if not isinstance(value, str) or not value.strip():
        raise ValueError("service origin is required")
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("service origin must be an absolute HTTP(S) URL")
    if require_https and parsed.scheme.lower() != "https":
        raise ValueError("production service origin must use HTTPS")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("service origin must not contain credentials, query, or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError("service origin must not contain a path")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("service origin has an invalid port") from exc
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    # Keep a non-default explicit port because it is part of an origin.
    default_port = (parsed.scheme.lower() == "http" and port == 80) or (parsed.scheme.lower() == "https" and port == 443)
    netloc = host if port is None or default_port else f"{host}:{port}"
    return f"{parsed.scheme.lower()}://{netloc}"


def _non_empty_strings(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return ()
    if isinstance(raw, str):
        values: Iterable[Any] = raw.split()
    elif isinstance(raw, (list, tuple, set, frozenset)):
        values = raw
    else:
        return ()
    return tuple(dict.fromkeys(item.strip() for item in values if isinstance(item, str) and item.strip()))


def _normalise_pem(value: str) -> str:
    return value.replace("\\n", "\n").strip()


def _parse_bool(value: Any, *, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"}:
        return True
    if isinstance(value, str) and value.strip().lower() in {"0", "false", "no"}:
        return False
    raise ValueError("service identity boolean configuration is invalid")


def _optional_int(value: Any, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"service identity trust field {name} must be an integer")
    return value


def _parse_target_bindings(raw: Any) -> frozenset[tuple[str | None, str | None, str]]:
    if raw is None:
        return frozenset()
    if not isinstance(raw, (list, tuple)):
        raise ValueError("service identity target_bindings must be an array")
    parsed: set[tuple[str | None, str | None, str]] = set()
    for item in raw:
        if not isinstance(item, Mapping):
            raise ValueError("service identity target binding must be an object")
        enterprise_id = item.get("enterprise_id")
        tenant_id = item.get("tenant_id")
        origin = item.get("origin")
        if enterprise_id is not None and (not isinstance(enterprise_id, str) or not enterprise_id.strip() or "*" in enterprise_id):
            raise ValueError("service identity target binding has an invalid enterprise_id")
        if tenant_id is not None and (not isinstance(tenant_id, str) or not tenant_id.strip() or "*" in tenant_id):
            raise ValueError("service identity target binding has an invalid tenant_id")
        if not enterprise_id and not tenant_id:
            raise ValueError("service identity target binding needs enterprise_id or tenant_id")
        if not isinstance(origin, str) or not origin.strip():
            raise ValueError("service identity target binding requires origin")
        parsed.add((enterprise_id.strip() if enterprise_id else None, tenant_id.strip() if tenant_id else None, canonical_origin(origin)))
    return frozenset(parsed)


def _load_rsa_private_key(private_pem: str):
    try:
        key = serialization.load_pem_private_key(_normalise_pem(private_pem).encode(), password=None)
    except Exception as exc:  # noqa: BLE001 - do not expose key parsing details
        raise ValueError("service identity private key is invalid") from exc
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("service identity private key must be RSA")
    if key.key_size < MIN_RSA_KEY_SIZE:
        raise ValueError(f"service identity RSA key must be at least {MIN_RSA_KEY_SIZE} bits")
    return key


@dataclass(frozen=True)
class TrustedServiceKey:
    """Public trust registration for one service assertion key."""

    public_key: str
    issuer: str | None = None
    subject: str | None = None
    deployment_id: str | None = None
    audiences: frozenset[str] = frozenset()
    origins: frozenset[str] = frozenset()
    enterprise_ids: frozenset[str] = frozenset()
    tenant_ids: frozenset[str] = frozenset()
    # Production target checks use exact tuples rather than independent
    # enterprise/tenant allowlists. ``None`` is meaningful for the frozen
    # tenant-only F02 contract and for F01's enterprise provisioning authority.
    target_bindings: frozenset[tuple[str | None, str | None, str]] = frozenset()
    scopes: frozenset[str] = frozenset()
    provisioning_capabilities: frozenset[str] = frozenset()
    status: str | None = None
    not_before: int | None = None
    expires_at: int | None = None
    revoked_at: int | None = None

    @classmethod
    def from_value(cls, value: Any) -> "TrustedServiceKey":
        if isinstance(value, cls):
            return value
        if isinstance(value, str):
            return cls(public_key=value)
        if not isinstance(value, Mapping):
            raise ValueError("service identity trust entry must be an object")
        public_key = value.get("public_key") or value.get("public_pem") or value.get("key")
        if not isinstance(public_key, str) or not public_key.strip():
            raise ValueError("service identity trust entry is missing public_key")
        if any(name in value for name in ("private_key", "private_pem", "d", "p", "q", "dp", "dq", "qi")):
            raise ValueError("service identity trust entry must not contain private key material")
        audiences = value.get("audiences", value.get("audience"))
        origins = value.get("origins", value.get("origin"))
        enterprise_ids = value.get("enterprise_ids", value.get("enterprise_id"))
        tenant_ids = value.get("tenant_ids", value.get("tenant_id"))
        scopes = value.get("scopes", value.get("scope"))
        provisioning_capabilities = value.get("provisioning_capabilities", value.get("capabilities"))
        target_bindings = _parse_target_bindings(value.get("target_bindings", value.get("bindings")))
        return cls(
            public_key=_normalise_pem(public_key),
            issuer=value.get("issuer", value.get("iss")),
            subject=value.get("subject", value.get("sub")),
            deployment_id=value.get("deployment_id"),
            audiences=frozenset(_non_empty_strings(audiences)),
            origins=frozenset(canonical_origin(item) for item in _non_empty_strings(origins)),
            enterprise_ids=frozenset(_non_empty_strings(enterprise_ids)),
            tenant_ids=frozenset(_non_empty_strings(tenant_ids)),
            target_bindings=target_bindings,
            scopes=frozenset(_non_empty_strings(scopes)),
            provisioning_capabilities=frozenset(_non_empty_strings(provisioning_capabilities)),
            status=value.get("status", value.get("key_status")),
            not_before=_optional_int(value.get("not_before", value.get("valid_from")), "not_before"),
            expires_at=_optional_int(value.get("expires_at", value.get("valid_until")), "expires_at"),
            revoked_at=_optional_int(value.get("revoked_at"), "revoked_at"),
        )


class ServiceIdentityReplayCache:
    """Small bounded replay guard for short-lived service assertions.

    This cache is intentionally a *single-instance* mechanism. Production
    launch validation must explicitly opt into that topology; a deployment
    with multiple receivers needs an approved shared replay store or gateway
    guarantee instead. This class never pretends process-local state is
    multi-instance safe.
    """

    def __init__(self, *, max_entries: int = 10_000, clock: Callable[[], float] | None = None):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        self._max_entries = max_entries
        self._clock = clock or time.time
        self._seen: dict[tuple[str, str], int] = {}
        self._lock = threading.Lock()

    def check_and_store(self, *, kid: str, jti: str, expires_at: int) -> bool:
        """Return ``False`` for a replay and retain a first-seen assertion."""

        now = int(self._clock())
        key = (kid, jti)
        with self._lock:
            for stale in [item for item, expiry in self._seen.items() if expiry + MAX_CLOCK_SKEW_SECONDS < now]:
                self._seen.pop(stale, None)
            if key in self._seen:
                return False
            if len(self._seen) >= self._max_entries:
                oldest = min(self._seen, key=self._seen.get)
                self._seen.pop(oldest, None)
            self._seen[key] = expires_at
            return True


class ServiceIdentitySigner:
    """Issue one short-lived RS256 assertion per outbound request."""

    def __init__(
        self,
        private_key: str,
        *,
        kid: str,
        issuer: str,
        subject: str,
        deployment_id: str,
        audience: str | None = None,
        origin: str | None = None,
        ttl_seconds: int = 30,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if not kid.strip() or not issuer.strip() or not subject.strip() or not deployment_id.strip():
            raise ValueError("service identity key, issuer, subject and deployment_id are required")
        if not 1 <= ttl_seconds <= MAX_ASSERTION_TTL_SECONDS:
            raise ValueError(f"service identity ttl must be between 1 and {MAX_ASSERTION_TTL_SECONDS} seconds")
        self._private_key = _load_rsa_private_key(private_key)
        self.kid = kid
        self.issuer = issuer
        self.subject = subject
        self.deployment_id = deployment_id
        self.audience = audience.strip() if isinstance(audience, str) and audience.strip() else None
        self.origin = canonical_origin(origin) if origin else None
        self.ttl_seconds = ttl_seconds
        self._clock = clock or time.time

    @classmethod
    def from_env(cls, *, subject: str | None = None) -> "ServiceIdentitySigner | None":
        """Build a signer only when the complete private-key configuration exists.

        A partially configured production identity returns ``None`` so the
        caller can fail closed without guessing a key, issuer or deployment.
        """

        private_key = os.getenv("SERVICE_IDENTITY_PRIVATE_KEY")
        kid = os.getenv("SERVICE_IDENTITY_KEY_ID")
        issuer = os.getenv("SERVICE_IDENTITY_ISSUER")
        deployment_id = os.getenv("SERVICE_IDENTITY_DEPLOYMENT_ID")
        if not all(isinstance(item, str) and item.strip() for item in (private_key, kid, issuer, deployment_id)):
            return None
        raw_ttl = os.getenv("SERVICE_IDENTITY_TTL_SECONDS") or str(DEFAULT_SERVICE_ASSERTION_TTL_SECONDS)
        try:
            ttl = int(raw_ttl)
        except ValueError as exc:
            raise ValueError("SERVICE_IDENTITY_TTL_SECONDS must be an integer") from exc
        resolved_subject = (subject or os.getenv("SERVICE_IDENTITY_SUBJECT") or "").strip()
        if not resolved_subject:
            return None
        return cls(
            private_key,
            kid=kid.strip(),
            issuer=issuer.strip(),
            subject=resolved_subject,
            deployment_id=deployment_id.strip(),
            audience=os.getenv("SERVICE_IDENTITY_AUDIENCE"),
            origin=os.getenv("SERVICE_IDENTITY_ORIGIN"),
            ttl_seconds=ttl,
        )

    def sign(
        self,
        *,
        audience: str,
        scope: Iterable[str] = (),
        enterprise_id: str | None = None,
        tenant_id: str | None = None,
        path: str,
        body: bytes | None = None,
        origin: str | None = None,
        capability: str | None = None,
        idempotency_key: str | None = None,
        now: int | None = None,
        jti: str | None = None,
    ) -> str:
        if not audience or not audience.strip():
            raise ValueError("service identity audience is required")
        if not path.startswith("/"):
            raise ValueError("service identity path must be absolute")
        if not tenant_id and enterprise_id:
            raise ValueError("enterprise-scoped service identity requires tenant_id")
        if enterprise_id is not None and (not enterprise_id.strip() or "*" in enterprise_id):
            raise ValueError("service identity enterprise_id must not contain wildcard characters")
        if tenant_id is not None and (not tenant_id.strip() or "*" in tenant_id):
            raise ValueError("service identity tenant_id must not contain wildcard characters")
        if idempotency_key is not None and (not idempotency_key.strip() or len(idempotency_key) > 200):
            raise ValueError("service identity idempotency_key must be 1-200 characters")
        if capability is not None and (not capability.strip() or len(capability) > 120 or "*" in capability):
            raise ValueError("service identity capability must be a non-wildcard value")
        resolved_origin = canonical_origin(origin, require_https=False) if origin else self.origin
        issued_at = int(self._clock()) if now is None else int(now)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "sub": self.subject,
            "aud": audience.strip(),
            "purpose": SERVICE_PURPOSE,
            "deployment_id": self.deployment_id,
            "iat": issued_at,
            "nbf": issued_at,
            "exp": issued_at + self.ttl_seconds,
            "jti": jti or secrets.token_urlsafe(24),
            "path": path,
        }
        if resolved_origin:
            claims["origin"] = resolved_origin
        if capability:
            claims["capability"] = capability
        if idempotency_key:
            claims["idempotency_key"] = idempotency_key
        normalised_scope = _non_empty_strings(scope if isinstance(scope, str) else tuple(scope))
        if normalised_scope:
            claims["scope"] = list(normalised_scope)
        if enterprise_id:
            claims["enterprise_id"] = enterprise_id
        if tenant_id:
            claims["tenant_id"] = tenant_id
        digest = body_sha256(body)
        if digest:
            claims["body_sha256"] = digest
        return jwt.encode(claims, self._private_key, algorithm=SERVICE_ASSERTION_ALGORITHM, headers={"kid": self.kid, "typ": "JWT"})

    # Explicit aliases make the primitive convenient to use from contract
    # tests without introducing a second signing implementation.
    issue = sign


class ServiceIdentityVerifier:
    """Verify service assertions against an explicitly registered key map."""

    def __init__(
        self,
        public_keys_by_kid: Mapping[str, Any] | None = None,
        *,
        trusted_keys: Mapping[str, Any] | None = None,
        expected_issuer: str | None = None,
        issuer: str | None = None,
        expected_audience: str | None = None,
        audience: str | None = None,
        expected_origin: str | None = None,
        origin: str | None = None,
        allowed_origins: Iterable[str] | None = None,
        allowed_enterprise_ids: Iterable[str] | None = None,
        allowed_tenant_ids: Iterable[str] | None = None,
        allowed_scopes: Iterable[str] | None = None,
        require_scope_binding: bool = False,
        require_origin_binding: bool = False,
        single_instance: bool = True,
        clock_skew_seconds: int = MAX_CLOCK_SKEW_SECONDS,
        clock: Callable[[], float] | None = None,
        replay_cache: ServiceIdentityReplayCache | None = None,
    ) -> None:
        if not 0 <= clock_skew_seconds <= MAX_CLOCK_SKEW_SECONDS:
            raise ValueError(f"service identity clock skew must be between 0 and {MAX_CLOCK_SKEW_SECONDS} seconds")
        raw_keys = dict(trusted_keys or public_keys_by_kid or {})
        if not raw_keys:
            raise ValueError("service identity trust keys are required")
        self._keys = {kid: TrustedServiceKey.from_value(value) for kid, value in raw_keys.items() if isinstance(kid, str) and kid.strip()}
        if len(self._keys) != len(raw_keys):
            raise ValueError("service identity trust key ids must be non-empty strings")
        self._expected_issuer = (expected_issuer or issuer or "").strip() or None
        self._expected_audience = (expected_audience or audience or "").strip() or None
        raw_origin = expected_origin or origin
        try:
            self._expected_origin = canonical_origin(raw_origin) if raw_origin else None
            self._allowed_origins = frozenset(canonical_origin(item) for item in _non_empty_strings(allowed_origins))
        except ValueError as exc:
            raise ValueError("service identity origin trust configuration is invalid") from exc
        self._allowed_enterprises = frozenset(_non_empty_strings(allowed_enterprise_ids))
        self._allowed_tenants = frozenset(_non_empty_strings(allowed_tenant_ids))
        if require_scope_binding and any("*" in item for item in (*self._allowed_enterprises, *self._allowed_tenants)):
            raise ValueError("production service target allowlists must not contain wildcards")
        self._allowed_scopes = frozenset(_non_empty_strings(allowed_scopes))
        self._require_scope_binding = require_scope_binding
        self._require_origin_binding = require_origin_binding
        self._single_instance = single_instance
        self._clock_skew_seconds = clock_skew_seconds
        self._clock = clock or time.time
        self._replay_cache = replay_cache or ServiceIdentityReplayCache(clock=self._clock)
        if self._require_scope_binding and (self._allowed_enterprises or self._allowed_tenants):
            raise ValueError("production service target trust must use exact target_bindings")
        if self._require_scope_binding:
            self._validate_trust_registration()

    def _validate_trust_registration(self) -> None:
        """Validate production registration shape before the first request."""

        for trusted in self._keys.values():
            if not trusted.issuer or not trusted.subject or not trusted.deployment_id:
                raise ValueError("service identity trust metadata is incomplete")
            if trusted.status not in {"active", "next", "revoked", "disabled"}:
                raise ValueError("service identity key status is invalid")
            if trusted.not_before is None or trusted.expires_at is None or trusted.expires_at <= trusted.not_before:
                raise ValueError("service identity key validity is invalid")
            try:
                public_key = serialization.load_pem_public_key(_normalise_pem(trusted.public_key).encode())
            except Exception as exc:  # noqa: BLE001 - malformed trust fails before launch
                raise ValueError("service identity trust public key is invalid") from exc
            if not isinstance(public_key, rsa.RSAPublicKey):
                raise ValueError("service identity trust public key must be RSA")
            if public_key.key_size < MIN_RSA_KEY_SIZE:
                raise ValueError(f"service identity RSA key must be at least {MIN_RSA_KEY_SIZE} bits")
            if any("*" in item for item in (*trusted.enterprise_ids, *trusted.tenant_ids)):
                raise ValueError("service identity trust IDs must not contain wildcards")
            if not trusted.audiences or not trusted.scopes or not trusted.origins:
                raise ValueError("service identity trust audience/origin/scope metadata is incomplete")
            if self._expected_audience and self._expected_audience not in trusted.audiences:
                raise ValueError("service identity trust audience does not match local audience")
            if any("*" in capability for capability in trusted.provisioning_capabilities):
                raise ValueError("service identity provisioning capabilities must not be wildcards")
            if not trusted.target_bindings and not trusted.provisioning_capabilities:
                raise ValueError("service identity target binding or provisioning capability registration is missing")
            if any(not item.startswith("https://") for item in trusted.origins):
                raise ValueError("production service identity origins must use HTTPS")
            if self._require_origin_binding and self._expected_origin and self._expected_origin not in trusted.origins:
                raise ValueError("service identity expected origin is not registered")
            if any(binding_origin not in trusted.origins for _, _, binding_origin in trusted.target_bindings):
                raise ValueError("service identity target binding origin is not registered")
    @classmethod
    def from_settings(cls, settings: Any) -> "ServiceIdentityVerifier | None":
        trust = getattr(settings, "service_identity_trust", None) or {}
        public_keys = getattr(settings, "service_identity_public_keys", None) or {}
        if not trust and not public_keys:
            return None
        environment = getattr(settings, "aiteam_env", None) or os.getenv("AITEAM_ENV", "development")
        merged_trust: dict[str, Any] = {}
        for kid, metadata in trust.items():
            if isinstance(metadata, Mapping) and not any(
                metadata.get(name) for name in ("public_key", "public_pem", "key")
            ) and kid in public_keys:
                merged_trust[kid] = {**metadata, "public_key": public_keys[kid]}
            else:
                merged_trust[kid] = metadata
        return cls(
            public_keys_by_kid=public_keys,
            trusted_keys=merged_trust or None,
            expected_issuer=getattr(settings, "service_identity_issuer", None),
            expected_audience=getattr(settings, "service_identity_audience", None) or getattr(settings, "service_name", None),
            expected_origin=getattr(settings, "service_identity_origin", None),
            allowed_origins=getattr(settings, "service_identity_allowed_origins", ()),
            allowed_enterprise_ids=getattr(settings, "service_identity_allowed_enterprises", ()),
            allowed_tenant_ids=getattr(settings, "service_identity_allowed_tenants", ()),
            allowed_scopes=getattr(settings, "service_identity_allowed_scopes", ()),
            require_scope_binding=environment == "production",
            require_origin_binding=environment == "production",
            single_instance=getattr(settings, "service_identity_single_instance", False) if environment == "production" else True,
            clock_skew_seconds=getattr(settings, "service_identity_clock_skew_seconds", MAX_CLOCK_SKEW_SECONDS),
        )

    @classmethod
    def from_env(cls, *, expected_audience: str | None = None) -> "ServiceIdentityVerifier | None":
        """Build the verifier from deployment trust configuration, if present."""

        raw_public = os.getenv("SERVICE_IDENTITY_PUBLIC_KEYS")
        raw_trust = os.getenv("SERVICE_IDENTITY_TRUST_JSON")
        if not raw_public and not raw_trust:
            return None
        try:
            public_keys = json.loads(raw_public) if raw_public else {}
            trust = json.loads(raw_trust) if raw_trust else {}
        except json.JSONDecodeError as exc:
            raise ValueError("service identity trust configuration is invalid") from exc
        if not isinstance(public_keys, dict) or not isinstance(trust, dict):
            raise ValueError("service identity trust configuration must be JSON objects")
        environment = os.getenv("AITEAM_ENV", "development")
        merged_trust: dict[str, Any] = {}
        for kid, metadata in trust.items():
            if isinstance(metadata, Mapping) and not any(
                metadata.get(name) for name in ("public_key", "public_pem", "key")
            ) and kid in public_keys:
                merged_trust[kid] = {**metadata, "public_key": public_keys[kid]}
            else:
                merged_trust[kid] = metadata
        return cls(
            public_keys_by_kid=public_keys,
            trusted_keys=merged_trust or None,
            expected_issuer=os.getenv("SERVICE_IDENTITY_ISSUER"),
            expected_audience=expected_audience or os.getenv("SERVICE_IDENTITY_AUDIENCE"),
            expected_origin=os.getenv("SERVICE_IDENTITY_ORIGIN"),
            allowed_origins=_non_empty_strings(os.getenv("SERVICE_IDENTITY_ALLOWED_ORIGINS")),
            allowed_enterprise_ids=_non_empty_strings(os.getenv("SERVICE_IDENTITY_ALLOWED_ENTERPRISES")),
            allowed_tenant_ids=_non_empty_strings(os.getenv("SERVICE_IDENTITY_ALLOWED_TENANTS")),
            allowed_scopes=_non_empty_strings(os.getenv("SERVICE_IDENTITY_ALLOWED_SCOPES")),
            require_scope_binding=environment == "production",
            require_origin_binding=environment == "production",
            single_instance=_parse_bool(os.getenv("SERVICE_IDENTITY_SINGLE_INSTANCE"), default=False) if environment == "production" else True,
            clock_skew_seconds=int(os.getenv("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS", "30")),
        )

    def verify(
        self,
        token: str,
        *,
        path: str,
        body: bytes | None = None,
        required_scope: str | None = None,
        required_enterprise_id: str | None = None,
        required_tenant_id: str | None = None,
        require_enterprise_scope: bool = False,
        reject_enterprise_scope: bool = False,
        target_binding: str | None = None,
        required_capability: str | None = None,
        expected_origin: str | None = None,
        expected_idempotency_key: str | None = None,
        audience: str | None = None,
    ) -> ServicePrincipal:
        if not token or token.count(".") != 2:
            raise Unauthorized("invalid service identity")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise Unauthorized("invalid service identity") from exc
        if header.get("alg") != SERVICE_ASSERTION_ALGORITHM:
            raise Unauthorized("invalid service identity algorithm")
        if set(header) - {"alg", "kid", "typ"}:
            raise Unauthorized("untrusted service identity key reference")
        if any(name in header for name in _FORBIDDEN_JWT_HEADERS):
            raise Unauthorized("untrusted service identity key reference")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid.strip() or kid not in self._keys:
            raise Unauthorized("unknown service identity key")
        trusted = self._keys[kid]
        now = int(self._clock())
        if self._require_scope_binding:
            if not trusted.issuer or not trusted.subject or not trusted.deployment_id:
                raise Unauthorized("service identity trust metadata is incomplete")
            if trusted.status not in {"active", "next"}:
                raise Unauthorized("service identity key is not active")
            if trusted.not_before is None or trusted.expires_at is None:
                raise Unauthorized("service identity key validity is not configured")
            if now + self._clock_skew_seconds < trusted.not_before:
                raise Unauthorized("service identity key is not active")
            if now - self._clock_skew_seconds >= trusted.expires_at:
                raise Unauthorized("service identity key has expired")
            if trusted.revoked_at is not None and now >= trusted.revoked_at:
                raise Unauthorized("service identity key is revoked")
            if not self._single_instance:
                raise Unauthorized("service identity replay topology is not approved")
        issuer = trusted.issuer or self._expected_issuer
        expected_audience = audience or self._expected_audience or (next(iter(trusted.audiences), None) if len(trusted.audiences) == 1 else None)
        raw_expected_origin = expected_origin or self._expected_origin
        try:
            resolved_expected_origin = canonical_origin(raw_expected_origin) if raw_expected_origin else None
        except ValueError as exc:
            raise Unauthorized("service identity origin trust configuration is invalid") from exc
        if not issuer or not expected_audience:
            raise Unauthorized("service identity trust configuration is incomplete")
        if trusted.audiences and expected_audience not in trusted.audiences:
            raise Unauthorized("service identity audience is not trusted")
        if self._require_origin_binding and not resolved_expected_origin:
            raise Unauthorized("service identity origin trust configuration is incomplete")
        if self._require_origin_binding and resolved_expected_origin and not resolved_expected_origin.startswith("https://"):
            raise Unauthorized("production service identity origin must use HTTPS")
        if self._require_origin_binding and not trusted.origins:
            raise Unauthorized("service identity registered origin is missing")
        if resolved_expected_origin and self._allowed_origins and resolved_expected_origin not in self._allowed_origins:
            raise Unauthorized("service identity origin is not allowed")
        try:
            payload = jwt.decode(
                token,
                _normalise_pem(trusted.public_key),
                algorithms=[SERVICE_ASSERTION_ALGORITHM],
                issuer=issuer,
                audience=expected_audience,
                leeway=self._clock_skew_seconds,
                options={"require": list(_REQUIRED_CLAIMS), "verify_iat": True},
            )
        except jwt.ExpiredSignatureError as exc:
            raise Unauthorized("service identity expired") from exc
        except jwt.ImmatureSignatureError as exc:
            raise Unauthorized("service identity is not active") from exc
        except jwt.PyJWTError as exc:
            raise Unauthorized("invalid service identity") from exc
        except Exception as exc:  # noqa: BLE001 - malformed trust material fails closed
            raise Unauthorized("invalid service identity trust key") from exc

        if set(payload) - _ALLOWED_CLAIMS:
            raise Unauthorized("invalid service identity claims")
        if payload.get("purpose") != SERVICE_PURPOSE:
            raise Unauthorized("invalid service identity purpose")
        if not isinstance(payload.get("iss"), str) or payload["iss"] != issuer:
            raise Unauthorized("service identity issuer is not trusted")
        if trusted.subject and payload.get("sub") != trusted.subject:
            raise Unauthorized("service identity subject is not trusted")
        if trusted.deployment_id and payload.get("deployment_id") != trusted.deployment_id:
            raise Unauthorized("service deployment is not trusted")
        if not isinstance(payload.get("aud"), str) or payload["aud"] != expected_audience:
            raise Unauthorized("service identity audience is not trusted")
        claim_origin = payload.get("origin")
        if claim_origin is not None and not isinstance(claim_origin, str):
            raise Unauthorized("invalid service identity origin")
        if claim_origin:
            try:
                claim_origin = canonical_origin(claim_origin, require_https=self._require_origin_binding)
            except ValueError as exc:
                raise Unauthorized("invalid service identity origin") from exc
        if self._require_origin_binding and not claim_origin:
            raise Unauthorized("service identity origin is required")
        if resolved_expected_origin and claim_origin != resolved_expected_origin:
            raise Forbidden("service identity origin does not match target")
        if trusted.origins and claim_origin not in trusted.origins:
            raise Forbidden("service identity origin is not registered")

        def _required_int(name: str) -> int:
            value = payload.get(name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise Unauthorized("invalid service identity time claims")
            return value

        issued_at = _required_int("iat")
        not_before = _required_int("nbf")
        expires_at = _required_int("exp")
        if expires_at <= issued_at or expires_at - issued_at > MAX_ASSERTION_TTL_SECONDS:
            raise Unauthorized("service identity lifetime is too long")
        if not_before > issued_at:
            raise Unauthorized("invalid service identity activation window")

        raw_scope = payload.get("scope", ())
        if isinstance(raw_scope, str):
            scope_values: Iterable[Any] = raw_scope.split()
        elif isinstance(raw_scope, (list, tuple)):
            scope_values = raw_scope
        elif raw_scope in (None, ()):
            scope_values = ()
        else:
            raise Unauthorized("invalid service identity scope")
        if any(not isinstance(item, str) or not item.strip() for item in scope_values):
            raise Unauthorized("invalid service identity scope")
        scope = tuple(dict.fromkeys(item.strip() for item in scope_values))
        if required_scope and required_scope not in scope:
            raise Forbidden("service identity scope is not authorized")
        if self._allowed_scopes and any(item not in self._allowed_scopes for item in scope):
            raise Forbidden("service identity scope is not authorized")
        if trusted.scopes and any(item not in trusted.scopes for item in scope):
            raise Forbidden("service identity scope is not authorized")
        if required_scope and self._require_scope_binding and not trusted.scopes and not self._allowed_scopes:
            raise Unauthorized("service identity scope registration is missing")

        enterprise_id = payload.get("enterprise_id")
        tenant_id = payload.get("tenant_id")
        if enterprise_id is not None and (not isinstance(enterprise_id, str) or not enterprise_id.strip() or "*" in enterprise_id):
            raise Unauthorized("invalid service enterprise scope")
        if tenant_id is not None and (not isinstance(tenant_id, str) or not tenant_id.strip() or "*" in tenant_id):
            raise Unauthorized("invalid service tenant scope")
        if reject_enterprise_scope and enterprise_id is not None:
            raise Forbidden("this service route accepts tenant scope only")
        if require_enterprise_scope and not enterprise_id:
            raise Forbidden("service enterprise scope is required")
        if required_tenant_id and "*" in required_tenant_id:
            raise Unauthorized("invalid service tenant target")
        if required_enterprise_id and "*" in required_enterprise_id:
            raise Unauthorized("invalid service enterprise target")
        if required_tenant_id and tenant_id != required_tenant_id:
            raise Forbidden("service tenant scope does not match target")
        if required_enterprise_id and enterprise_id != required_enterprise_id:
            raise Forbidden("service enterprise scope does not match target")
        if target_binding not in {None, "provision-enterprise", "tenant-only", "enterprise-tenant"}:
            raise Unauthorized("service target binding policy is invalid")
        if required_capability is not None and (not required_capability.strip() or "*" in required_capability):
            raise Unauthorized("service capability policy is invalid")
        capability = payload.get("capability")
        if capability is not None and (not isinstance(capability, str) or not capability.strip() or "*" in capability):
            raise Unauthorized("invalid service capability")
        if required_capability and self._require_scope_binding:
            if (
                capability != required_capability
                or required_capability not in trusted.provisioning_capabilities
            ):
                raise Forbidden("service provisioning capability is not authorized")
        if target_binding and self._require_scope_binding:
            if target_binding == "provision-enterprise" and required_capability and capability == required_capability:
                # A registered non-wildcard provisioning capability authorizes
                # the exact enterprise/tenant IDs in this signed assertion.
                pass
            elif not trusted.target_bindings:
                raise Unauthorized("service target binding registration is missing")
            else:
                binding_origin = claim_origin or resolved_expected_origin
                matched = False
                for bound_enterprise, bound_tenant, bound_origin in trusted.target_bindings:
                    if bound_origin != binding_origin:
                        continue
                    if target_binding == "provision-enterprise":
                        matched = bound_enterprise == enterprise_id and bound_tenant in {None, tenant_id}
                    elif target_binding == "tenant-only":
                        matched = bound_enterprise is None and bound_tenant == tenant_id
                    else:
                        matched = bound_enterprise == enterprise_id and bound_tenant == tenant_id
                    if matched:
                        break
                if not matched:
                    raise Forbidden("service target binding is not authorized")
        if self._allowed_enterprises and enterprise_id not in self._allowed_enterprises and not (
            target_binding == "tenant-only" and enterprise_id is None
        ):
            raise Forbidden("service enterprise scope is not authorized")
        if self._allowed_tenants and tenant_id not in self._allowed_tenants:
            raise Forbidden("service tenant scope is not authorized")
        if self._require_scope_binding and (enterprise_id or tenant_id):
            if not trusted.enterprise_ids and not trusted.tenant_ids and not trusted.target_bindings and not trusted.provisioning_capabilities and not self._allowed_enterprises and not self._allowed_tenants:
                raise Unauthorized("service enterprise trust registration is missing")
        if require_enterprise_scope and self._require_scope_binding:
            if not trusted.enterprise_ids and not trusted.target_bindings and not trusted.provisioning_capabilities and not self._allowed_enterprises:
                raise Unauthorized("service enterprise trust registration is missing")
        if required_tenant_id and self._require_scope_binding and not require_enterprise_scope:
            if not trusted.tenant_ids and not trusted.target_bindings and not self._allowed_tenants:
                raise Unauthorized("service tenant trust registration is missing")
        if trusted.enterprise_ids and enterprise_id not in trusted.enterprise_ids and not (
            target_binding == "tenant-only" and enterprise_id is None
        ):
            raise Forbidden("service enterprise scope is not authorized")
        if trusted.tenant_ids and tenant_id not in trusted.tenant_ids:
            raise Forbidden("service tenant scope is not authorized")

        claim_path = payload.get("path")
        if not isinstance(claim_path, str) or claim_path != path:
            raise Unauthorized("service identity request target mismatch")
        expected_digest = body_sha256(body)
        claim_digest = payload.get("body_sha256")
        if expected_digest:
            if not isinstance(claim_digest, str) or claim_digest != expected_digest:
                raise Unauthorized("service identity request body mismatch")
        elif claim_digest is not None:
            raise Unauthorized("service identity request body mismatch")

        claim_idempotency_key = payload.get("idempotency_key")
        if claim_idempotency_key is not None and (
            not isinstance(claim_idempotency_key, str) or not claim_idempotency_key.strip() or len(claim_idempotency_key) > 200
        ):
            raise Unauthorized("invalid service identity idempotency key")
        if expected_idempotency_key is not None and claim_idempotency_key != expected_idempotency_key:
            raise Unauthorized("service identity idempotency key mismatch")
        if expected_idempotency_key is None and claim_idempotency_key is not None:
            raise Unauthorized("service identity idempotency key mismatch")

        jti = payload.get("jti")
        if not isinstance(jti, str) or not jti.strip():
            raise Unauthorized("invalid service identity replay id")
        if not self._replay_cache.check_and_store(kid=kid, jti=jti, expires_at=expires_at):
            raise Unauthorized("service identity replay detected")

        try:
            return ServicePrincipal(
                iss=payload["iss"],
                sub=payload["sub"],
                aud=payload["aud"],
                purpose=payload["purpose"],
                deployment_id=payload["deployment_id"],
                enterprise_id=enterprise_id,
                tenant_id=tenant_id,
                scope=scope,
                iat=issued_at,
                nbf=not_before,
                exp=expires_at,
                jti=jti,
                path=claim_path,
                body_sha256=claim_digest,
                origin=claim_origin,
                capability=capability,
                idempotency_key=claim_idempotency_key,
                kid=kid,
            )
        except Exception as exc:  # noqa: BLE001 - malformed claims are authentication failures
            raise Unauthorized("invalid service identity claims") from exc

    verify_token = verify


__all__ = [
    "DEFAULT_SERVICE_ASSERTION_TTL_SECONDS",
    "MAX_ASSERTION_TTL_SECONDS",
    "MAX_CLOCK_SKEW_SECONDS",
    "MIN_RSA_KEY_SIZE",
    "SERVICE_ASSERTION_ALGORITHM",
    "SERVICE_PURPOSE",
    "ServiceIdentityReplayCache",
    "ServiceIdentitySigner",
    "ServiceIdentityVerifier",
    "TrustedServiceKey",
    "body_sha256",
    "canonical_json_bytes",
    "canonical_origin",
    "request_target",
]
