"""Boundary cases for signed service identity helpers and verifier setup."""

from __future__ import annotations

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives import serialization

from shared.auth import generate_rsa_keypair
from shared.contracts.service_identity import ServicePrincipal
from shared.errors import Forbidden, Unauthorized
import shared.service_identity as service_identity
from shared.service_identity import (
    MAX_CLOCK_SKEW_SECONDS,
    ServiceIdentityReplayCache,
    ServiceIdentitySigner,
    ServiceIdentityVerifier,
    TrustedServiceKey,
    _non_empty_strings,
    _optional_int,
    _parse_bool,
    _parse_target_bindings,
    body_sha256,
    canonical_json_bytes,
    canonical_origin,
    request_target,
)

_PRIVATE_KEY, _PUBLIC_KEY = generate_rsa_keypair()


def _signer(**kwargs):
    values = {
        "kid": "k1",
        "issuer": "issuer",
        "subject": "subject",
        "deployment_id": "deployment",
        "ttl_seconds": 30,
    }
    values.update(kwargs)
    return ServiceIdentitySigner(_PRIVATE_KEY, **values)


def _verifier(*, scopes=("scope",), **kwargs):
    values = {
        "expected_issuer": "issuer",
        "expected_audience": "audience",
        "clock": lambda: time.time(),
    }
    values.update(kwargs)
    return ServiceIdentityVerifier({"k1": {"public_key": _PUBLIC_KEY, "scopes": list(scopes)}}, **values)


def _strict_verifier(*, status="active", target_bindings=None):
    now = int(time.time())
    return ServiceIdentityVerifier(
        {"k1": {
            "public_key": _PUBLIC_KEY,
            "issuer": "issuer",
            "subject": "subject",
            "deployment_id": "deployment",
            "audiences": ["audience"],
            "origins": ["https://manager.invalid"],
            "scopes": ["scope"],
            "provisioning_capabilities": ["provision-enterprise"],
            "status": status,
            "not_before": now - 30,
            "expires_at": now + 300,
            "target_bindings": target_bindings if target_bindings is not None else [
                {"enterprise_id": "enterprise-a", "tenant_id": "tenant-a", "origin": "https://manager.invalid"},
                {"tenant_id": "tenant-a", "origin": "https://manager.invalid"},
            ],
        }},
        expected_audience="audience",
        expected_origin="https://manager.invalid",
        require_scope_binding=True,
        require_origin_binding=True,
        single_instance=True,
    )


def test_service_principal_properties_and_aliases_are_typed():
    principal = ServicePrincipal(
        issuer="issuer", subject="subject", audience="audience", purpose="service",
        deployment_id="deployment", tenant_id="tenant", scope=["scope"],
        iat=1, nbf=1, exp=2, jti="jti", path="/target", kid="kid",
    )
    assert principal.issuer == "issuer"
    assert principal.subject == "subject"
    assert principal.audience == "audience"
    assert principal.scopes == ("scope",)
    assert principal.is_enterprise_scoped is True


def test_canonical_helpers_cover_normalization_and_invalid_inputs():
    assert canonical_json_bytes({"b": 1, "a": "é"}) == '{"a":"é","b":1}'.encode()
    assert body_sha256(b"payload")
    assert body_sha256(b"") is None
    assert request_target("users", "page=1") == "/users?page=1"
    assert request_target("/users") == "/users"
    assert canonical_origin("HTTPS://Example.test:443/") == "https://example.test"
    assert canonical_origin("http://[::1]:80") == "http://[::1]"

    for value in (None, "", "ftp://example.test", "//example.test", "https://u:p@example.test", "https://example.test/a", "https://example.test/?x=1", "https://example.test/#f", "https://example.test:bad"):
        with pytest.raises(ValueError):
            canonical_origin(value)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        canonical_origin("http://example.test", require_https=True)


def test_private_parsers_cover_scalar_and_binding_edges():
    assert _non_empty_strings(" a  b a ") == ("a", "b")
    assert _non_empty_strings([" a ", "", "a", 1]) == ("a",)
    assert _non_empty_strings(1) == ()
    assert _parse_bool(None, default=True) is True
    assert _parse_bool("", default=False) is False
    assert _parse_bool(True, default=False) is True
    assert _parse_bool("yes", default=False) is True
    assert _parse_bool("no", default=True) is False
    with pytest.raises(ValueError):
        _parse_bool("sometimes", default=False)
    assert _optional_int(None, "x") is None
    assert _optional_int(3, "x") == 3
    with pytest.raises(ValueError):
        _optional_int(True, "x")

    bindings = _parse_target_bindings([
        {"enterprise_id": "e1", "tenant_id": "t1", "origin": "https://manager.test"},
        {"tenant_id": "t1", "origin": "https://manager.test"},
    ])
    assert ("e1", "t1", "https://manager.test") in bindings
    assert (None, "t1", "https://manager.test") in bindings
    assert _parse_target_bindings(None) == frozenset()
    for value in ("not-array", [1], [{"origin": "https://manager.test"}], [{"enterprise_id": "e*", "origin": "https://manager.test"}], [{"tenant_id": "t*", "origin": "https://manager.test"}], [{"enterprise_id": "e1", "origin": "https://manager.test/path"}], [{"enterprise_id": "e1"}]):
        with pytest.raises(ValueError):
            _parse_target_bindings(value)


def test_trusted_key_and_private_key_validation():
    assert TrustedServiceKey.from_value(TrustedServiceKey(public_key=_PUBLIC_KEY)).public_key == _PUBLIC_KEY
    assert TrustedServiceKey.from_value(_PUBLIC_KEY).public_key == _PUBLIC_KEY
    with pytest.raises(ValueError):
        TrustedServiceKey.from_value(1)
    with pytest.raises(ValueError):
        TrustedServiceKey.from_value({})
    for key in ("private_key", "private_pem", "d", "p", "q", "dp", "dq", "qi"):
        with pytest.raises(ValueError):
            TrustedServiceKey.from_value({"public_key": _PUBLIC_KEY, key: "secret"})
    with pytest.raises(ValueError):
        ServiceIdentitySigner("not-a-key", kid="k", issuer="i", subject="s", deployment_id="d")
    ec_key = ec.generate_private_key(ec.SECP256R1())
    ec_pem = ec_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    with pytest.raises(ValueError):
        ServiceIdentitySigner(ec_pem, kid="k", issuer="i", subject="s", deployment_id="d")
    small = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    small_pem = small.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    with pytest.raises(ValueError, match="2048"):
        ServiceIdentitySigner(small_pem, kid="k", issuer="i", subject="s", deployment_id="d")


def test_replay_cache_expiry_and_bounded_eviction():
    now = [100.0]
    cache = ServiceIdentityReplayCache(max_entries=2, clock=lambda: now[0])
    assert cache.check_and_store(kid="k", jti="old", expires_at=90)
    assert cache.check_and_store(kid="k", jti="new", expires_at=200)
    assert not cache.check_and_store(kid="k", jti="new", expires_at=200)
    now[0] = 200
    assert cache.check_and_store(kid="k", jti="fresh", expires_at=300)
    bounded = ServiceIdentityReplayCache(max_entries=1, clock=lambda: 10)
    assert bounded.check_and_store(kid="k", jti="first", expires_at=100)
    assert bounded.check_and_store(kid="k", jti="second", expires_at=100)
    assert bounded.check_and_store(kid="k", jti="first", expires_at=100)
    with pytest.raises(ValueError):
        ServiceIdentityReplayCache(max_entries=0)


def test_signer_from_env_and_input_validation(monkeypatch):
    for name in ("SERVICE_IDENTITY_PRIVATE_KEY", "SERVICE_IDENTITY_KEY_ID", "SERVICE_IDENTITY_ISSUER", "SERVICE_IDENTITY_DEPLOYMENT_ID", "SERVICE_IDENTITY_SUBJECT"):
        monkeypatch.delenv(name, raising=False)
    assert ServiceIdentitySigner.from_env() is None
    monkeypatch.setenv("SERVICE_IDENTITY_PRIVATE_KEY", _PRIVATE_KEY)
    monkeypatch.setenv("SERVICE_IDENTITY_KEY_ID", "k1")
    monkeypatch.setenv("SERVICE_IDENTITY_ISSUER", "issuer")
    monkeypatch.setenv("SERVICE_IDENTITY_DEPLOYMENT_ID", "deployment")
    monkeypatch.setenv("SERVICE_IDENTITY_SUBJECT", "subject")
    monkeypatch.setenv("SERVICE_IDENTITY_TTL_SECONDS", "not-int")
    with pytest.raises(ValueError):
        ServiceIdentitySigner.from_env()
    monkeypatch.setenv("SERVICE_IDENTITY_TTL_SECONDS", "30")
    assert ServiceIdentitySigner.from_env().subject == "subject"
    monkeypatch.setenv("SERVICE_IDENTITY_SUBJECT", "")
    assert ServiceIdentitySigner.from_env() is None

    invalid = [
        {"audience": "", "path": "/x"},
        {"audience": "audience", "path": "x"},
        {"audience": "audience", "path": "/x", "enterprise_id": "e"},
        {"audience": "audience", "path": "/x", "tenant_id": "t*"},
        {"audience": "audience", "path": "/x", "idempotency_key": ""},
        {"audience": "audience", "path": "/x", "idempotency_key": "x" * 201},
        {"audience": "audience", "path": "/x", "capability": "cap*"},
    ]
    for values in invalid:
        with pytest.raises(ValueError):
            _signer().sign(body=None, **values)

def test_verifier_constructor_rejects_invalid_production_registration():
    now = int(time.time())
    base = {
        "public_key": _PUBLIC_KEY,
        "issuer": "issuer",
        "subject": "subject",
        "deployment_id": "deployment",
        "audiences": ["audience"],
        "origins": ["https://manager.test"],
        "scopes": ["scope"],
        "provisioning_capabilities": ["provision-enterprise"],
        "status": "active",
        "not_before": now - 1,
        "expires_at": now + 100,
        "target_bindings": [{"enterprise_id": "e", "tenant_id": "t", "origin": "https://manager.test"}],
    }
    cases = [
        {"clock_skew_seconds": MAX_CLOCK_SKEW_SECONDS + 1},
        {"trusted_keys": {}},
        {"trusted_keys": {"": base}},
        {"expected_origin": "not-an-origin"},
        {"allowed_enterprise_ids": ["*"] , "require_scope_binding": True},
        {"allowed_tenant_ids": ["*"] , "require_scope_binding": True},
        {"allowed_enterprise_ids": ["e"], "require_scope_binding": True},
    ]
    for kwargs in cases:
        with pytest.raises(ValueError):
            if "trusted_keys" in kwargs:
                ServiceIdentityVerifier(kwargs.pop("trusted_keys"), **kwargs)
            else:
                ServiceIdentityVerifier({"k1": base}, **kwargs)

    bad_fields = [
        {"status": "unknown"},
        {"not_before": None},
        {"public_key": "not-a-key"},
        {"public_key": ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()},
        {"public_key": rsa.generate_private_key(public_exponent=65537, key_size=1024).public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()},
        {"enterprise_ids": ["e*"]},
        {"audiences": []},
        {"scopes": []},
        {"provisioning_capabilities": ["*"]},
        {"target_bindings": [] , "provisioning_capabilities": []},
        {"origins": ["http://manager.test"]},
        {"target_bindings": [{"enterprise_id": "e", "origin": "https://other.test"}]},
    ]
    for override in bad_fields:
        item = dict(base)
        item.update(override)
        with pytest.raises(ValueError):
            ServiceIdentityVerifier({"k1": item}, expected_origin="https://manager.test", require_scope_binding=True, require_origin_binding=True)


def test_verifier_from_env_and_settings_merge(monkeypatch):
    monkeypatch.delenv("SERVICE_IDENTITY_PUBLIC_KEYS", raising=False)
    monkeypatch.delenv("SERVICE_IDENTITY_TRUST_JSON", raising=False)
    assert ServiceIdentityVerifier.from_env() is None
    monkeypatch.setenv("SERVICE_IDENTITY_PUBLIC_KEYS", "not-json")
    with pytest.raises(ValueError):
        ServiceIdentityVerifier.from_env()
    monkeypatch.setenv("SERVICE_IDENTITY_PUBLIC_KEYS", "[]")
    monkeypatch.setenv("SERVICE_IDENTITY_TRUST_JSON", "{}")
    with pytest.raises(ValueError):
        ServiceIdentityVerifier.from_env()
    monkeypatch.setenv("SERVICE_IDENTITY_PUBLIC_KEYS", json.dumps({"k1": _PUBLIC_KEY}))
    monkeypatch.setenv("SERVICE_IDENTITY_TRUST_JSON", json.dumps({"k1": {"issuer": "issuer", "subject": "subject", "deployment_id": "deployment"}}))
    monkeypatch.setenv("AITEAM_ENV", "development")
    assert ServiceIdentityVerifier.from_env(expected_audience="audience") is not None

    settings = type("Settings", (), {
        "aiteam_env": "development",
        "service_name": "audience",
        "service_identity_audience": "audience",
        "service_identity_issuer": "issuer",
        "service_identity_origin": None,
        "service_identity_public_keys": {"k1": _PUBLIC_KEY},
        "service_identity_trust": {"k1": {"issuer": "issuer", "subject": "subject", "deployment_id": "deployment"}},
        "service_identity_allowed_origins": (),
        "service_identity_allowed_enterprises": (),
        "service_identity_allowed_tenants": (),
        "service_identity_allowed_scopes": (),
        "service_identity_single_instance": True,
        "service_identity_clock_skew_seconds": 30,
    })()
    assert ServiceIdentityVerifier.from_settings(settings) is not None


def test_target_binding_policy_covers_enterprise_policy_prefixes():
    from shared.service_token import service_target_binding_policy

    assert service_target_binding_policy("/api/manager/enterprise-policy/tenant") == ("enterprise-tenant", False)
    assert service_target_binding_policy("/api/operation/enterprise-policy/tenant") == ("enterprise-tenant", False)


def test_replay_cache_uses_distinct_kid_jti_pairs():
    cache = ServiceIdentityReplayCache(clock=lambda: 1)
    assert cache.check_and_store(kid="k1", jti="j", expires_at=2)
    assert cache.check_and_store(kid="k2", jti="j", expires_at=2)
    assert not cache.check_and_store(kid="k1", jti="j", expires_at=2)


def _base_claims(*, jti: str = "edge") -> dict:
    token = _signer().sign(
        audience="audience",
        scope=["scope"],
        tenant_id="tenant-a",
        path="/target",
        now=int(time.time()),
        jti=jti,
    )
    return jwt.decode(token, options={"verify_signature": False})


def _token_for_claims(claims: dict, *, headers: dict | None = None, algorithm: str = "RS256") -> str:
    key = _PRIVATE_KEY if algorithm == "RS256" else "not-the-rsa-key"
    return jwt.encode(claims, key, algorithm=algorithm, headers=headers or {"kid": "k1", "typ": "JWT"})


def test_verify_rejects_malformed_header_and_claims():
    verifier = _verifier()
    for token in ("", "one.two"):
        with pytest.raises(Unauthorized):
            verifier.verify(token, path="/target")
    claims = _base_claims(jti="header-alg")
    with pytest.raises(Unauthorized):
        verifier.verify(_token_for_claims(claims, algorithm="HS256"), path="/target")
    with pytest.raises(Unauthorized):
        verifier.verify(_token_for_claims(claims, headers={"kid": "k1", "typ": "JWT", "foo": "bar"}), path="/target")
    with pytest.raises(Unauthorized):
        verifier.verify(_token_for_claims(claims, headers={"kid": "k1", "typ": "JWT", "jku": "https://evil.test"}), path="/target")
    with pytest.raises(Unauthorized):
        verifier.verify(_token_for_claims(claims, headers={"kid": "missing", "typ": "JWT"}), path="/target")

    verifier._keys["k1"] = TrustedServiceKey(
        public_key=_PUBLIC_KEY,
        issuer="issuer",
        subject="subject",
        deployment_id="deployment",
        audiences=frozenset({"audience"}),
    )
    mutations = [
        ("extra", {"unexpected": True}),
        ("purpose", {"purpose": "user"}),
        ("issuer", {"iss": "other"}),
        ("subject", {"sub": "other"}),
        ("deployment", {"deployment_id": "other"}),
        ("audience", {"aud": "other"}),
        ("origin-type", {"origin": 1}),
        ("scope-type", {"scope": 1}),
        ("scope-item", {"scope": ["scope", 1]}),
        ("enterprise-type", {"enterprise_id": 1}),
        ("tenant-type", {"tenant_id": 1}),
        ("capability-type", {"capability": 1}),
        ("idempotency-type", {"idempotency_key": 1}),
        ("jti-type", {"jti": 1}),
    ]
    for label, change in mutations:
        changed = dict(claims)
        changed.update(change)
        if label != "jti-type":
            changed["jti"] = f"mutation-{label}"
        with pytest.raises(Unauthorized):
            verifier.verify(_token_for_claims(changed), path="/target")


def test_verify_scope_origin_target_and_request_bindings(monkeypatch):
    claims = _base_claims(jti="shape")
    verifier = _verifier()

    def verify_payload(changes: dict, **kwargs):
        payload = dict(claims)
        payload.update(changes)
        payload["jti"] = f"shape-{len(changes)}-{time.time_ns()}"
        token = _token_for_claims(payload)
        monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: payload)
        return verifier.verify(token, path="/target", **kwargs)

    assert verify_payload({"scope": "scope"}).scope == ("scope",)
    assert verify_payload({"scope": None}).scope == ()
    for changes in ({"scope": {}}, {"scope": [""]}):
        with pytest.raises(Unauthorized):
            verify_payload(changes)
    with pytest.raises(Forbidden):
        verify_payload({"scope": ["other"]}, required_scope="required")
    with pytest.raises(Forbidden):
        _verifier(allowed_scopes=("other",)).verify(
            _token_for_claims(dict(claims, scope=["other"], jti="allowed-scope")),
            path="/target",
            required_scope="scope",
        )

    with pytest.raises(Unauthorized):
        verify_payload({"origin": 1})
    with pytest.raises(Forbidden):
        verify_payload({"origin": "https://other.test"}, expected_origin="https://manager.test")
    strict = _strict_verifier()
    strict_claims = dict(claims, origin="https://manager.invalid", enterprise_id=None, tenant_id="tenant-a", capability="provision-enterprise")
    token = _token_for_claims(strict_claims)
    monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: strict_claims)
    assert strict.verify(
        token,
        path="/target",
        required_scope="scope",
        required_tenant_id="tenant-a",
        target_binding="tenant-only",
        expected_origin="https://manager.invalid",
    ).tenant_id == "tenant-a"

    for changes in ({"enterprise_id": 1}, {"tenant_id": "t*"}):
        with pytest.raises(Unauthorized):
            verify_payload(changes)
    with pytest.raises(Forbidden):
        verify_payload({"enterprise_id": None}, require_enterprise_scope=True)
    with pytest.raises(Forbidden):
        verify_payload({"enterprise_id": "e"}, reject_enterprise_scope=True)
    with pytest.raises(Unauthorized):
        verify_payload({}, target_binding="bad")
    with pytest.raises(Unauthorized):
        verify_payload({}, required_capability="cap*")
    with pytest.raises(Unauthorized):
        verify_payload({"capability": "cap*"})
    with pytest.raises(Unauthorized):
        verify_payload({}, required_tenant_id="t*")
    with pytest.raises(Unauthorized):
        verify_payload({}, required_enterprise_id="e*")

    with pytest.raises(Unauthorized):
        verify_payload({"body_sha256": "bad"}, body=None)
    with pytest.raises(Unauthorized):
        verify_payload({}, body=b"body")
    with pytest.raises(Unauthorized):
        verify_payload({"idempotency_key": "key"}, expected_idempotency_key=None)
    with pytest.raises(Unauthorized):
        verify_payload({}, expected_idempotency_key="expected")


def test_verify_strict_registration_and_missing_metadata_paths(monkeypatch):
    now = int(time.time())
    base = {
        "public_key": _PUBLIC_KEY,
        "issuer": "issuer",
        "subject": "subject",
        "deployment_id": "deployment",
        "audiences": ["audience"],
        "origins": ["https://manager.test"],
        "scopes": ["scope"],
        "provisioning_capabilities": ["provision-enterprise"],
        "status": "active",
        "not_before": now - 1,
        "expires_at": now + 300,
        "target_bindings": [{"enterprise_id": "e", "tenant_id": "t", "origin": "https://manager.test"}],
    }
    for override, clock_value in (({"revoked_at": now - 1}, now), ({"not_before": now + 100}, now), ({"expires_at": now + 1}, now + 40)):
        item = dict(base, **override)
        verifier = ServiceIdentityVerifier({"k1": item}, expected_audience="audience", expected_origin="https://manager.test", require_scope_binding=True, require_origin_binding=True, clock=lambda: clock_value)
        token = _signer().sign(audience="audience", scope=["scope"], enterprise_id="e", tenant_id="t", capability="provision-enterprise", path="/target", origin="https://manager.test", now=now, jti=f"strict-{override}")
        with pytest.raises(Unauthorized):
            verifier.verify(token, path="/target", required_scope="scope", required_enterprise_id="e", required_tenant_id="t", require_enterprise_scope=True, target_binding="enterprise-tenant", expected_origin="https://manager.test")

    verifier = _verifier()
    payload = _base_claims(jti="strict-shape")
    token = _token_for_claims(payload)
    monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: payload)
    verifier._expected_audience = None
    verifier._keys["k1"] = TrustedServiceKey(public_key=_PUBLIC_KEY)
    with pytest.raises(Unauthorized):
        verifier.verify(token, path="/target")


def test_verify_lifetime_activation_and_scope_registration_edges(monkeypatch):
    base = _base_claims(jti="lifetime")
    verifier = _verifier()

    def run(changes, **kwargs):
        payload = dict(base, **changes, jti=f"lifetime-{time.time_ns()}")
        token = _token_for_claims(payload)
        monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: payload)
        return verifier.verify(token, path="/target", **kwargs)

    with pytest.raises(Unauthorized):
        run({"exp": base["iat"] + 61})
    with pytest.raises(Unauthorized):
        run({"nbf": base["iat"] + 1})
    with pytest.raises(Unauthorized):
        run({"iat": "bad"})
    with pytest.raises(Unauthorized):
        run({"exp": "bad"})
    with pytest.raises(Unauthorized):
        run({"nbf": "bad"})

    strict = _verifier(scopes=())
    strict._require_scope_binding = True
    payload = dict(base, jti="scope-registration")
    token = _token_for_claims(payload)
    monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: payload)
    with pytest.raises(Unauthorized):
        strict.verify(token, path="/target", required_scope="scope")


def test_verify_service_principal_construction_failure(monkeypatch):
    payload = _base_claims(jti="principal-failure")
    token = _token_for_claims(payload)
    monkeypatch.setattr(service_identity.jwt, "decode", lambda *_args, **_kwargs: payload)
    monkeypatch.setattr(service_identity, "ServicePrincipal", lambda **_kwargs: (_ for _ in ()).throw(ValueError("bad principal")))
    with pytest.raises(Unauthorized):
        _verifier().verify(token, path="/target")
