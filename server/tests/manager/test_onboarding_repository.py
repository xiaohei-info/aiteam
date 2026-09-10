from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from manager_service.onboarding_repository import OperatorTenantBindingRepository
from shared.errors import Conflict, Forbidden, NotFound
from manager_service.exceptions import ManagerControlPlaneUnavailable


class Cursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, *rows):
        self.rows = list(rows)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def transaction(self):
        return self

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return Cursor(self.rows.pop(0) if self.rows else None)


def principal(**overrides):
    values = dict(
        kid="operator-kid",
        iss="https://operator.example",
        sub="operator-service",
        aud="manager-service",
        deployment_id="operator-deployment",
        origin="https://operator.example",
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def test_f01_receipt_and_registry_are_written_in_one_admin_transaction():
    tenant = "11111111-1111-4111-8111-111111111111"
    enterprise = "22222222-2222-4222-8222-222222222222"
    connection = Connection(
        None,
        (tenant,),
        (tenant, enterprise, "acme", "acme-code"),
        (tenant,),
        (tenant, enterprise, "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"),
        ("f01-1", "fingerprint", tenant, enterprise, "acme", "acme-code"),
    )
    with patch("psycopg.connect", return_value=connection):
        inserted = OperatorTenantBindingRepository("postgresql://admin").ensure_registry_and_binding(
            tenant_id=tenant,
            enterprise_id=enterprise,
            enterprise_slug="acme",
            enterprise_code="acme-code",
            principal=principal(),
            idempotency_key="f01-1",
            request_fingerprint="fingerprint",
        )
    assert inserted is True
    assert "FROM manager_onboarding_receipt" in connection.calls[0][0]
    assert connection.calls[1][0].startswith("INSERT INTO tenant_registry")
    assert connection.calls[3][0].startswith("INSERT INTO operator_tenant_binding")
    assert connection.calls[5][0].startswith("INSERT INTO manager_onboarding_receipt")
    assert all("secret" not in str(params).lower() for _, params in connection.calls)


def test_f01_same_key_and_fingerprint_replays_after_revalidating_registry_binding():
    tenant = "11111111-1111-4111-8111-111111111111"
    enterprise = "22222222-2222-4222-8222-222222222222"
    connection = Connection(
        ("f01-1", "fingerprint", tenant, enterprise, "acme", "acme-code"),
        None,
        (tenant, enterprise, "acme", "acme-code"),
        (tenant, enterprise, "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"),
        None,
        (tenant, enterprise, "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"),
    )
    with patch("psycopg.connect", return_value=connection):
        replayed = OperatorTenantBindingRepository("postgresql://admin").ensure_registry_and_binding(
            tenant_id=tenant,
            enterprise_id=enterprise,
            enterprise_slug="acme",
            enterprise_code="acme-code",
            principal=principal(),
            idempotency_key="f01-1",
            request_fingerprint="fingerprint",
        )
    assert replayed is False
    assert len(connection.calls) == 6
    assert "tenant_registry" in connection.calls[1][0]
    assert "operator_tenant_binding" in connection.calls[4][0]


def test_f01_same_key_with_different_target_or_fingerprint_is_rejected():
    tenant = "11111111-1111-4111-8111-111111111111"
    enterprise = "22222222-2222-4222-8222-222222222222"
    connection = Connection(
        ("f01-1", "other-fingerprint", tenant, enterprise, "acme", "acme-code"),
    )
    with patch("psycopg.connect", return_value=connection), pytest.raises(Conflict, match="Idempotency-Key"):
        OperatorTenantBindingRepository("postgresql://admin").ensure_registry_and_binding(
            tenant_id=tenant,
            enterprise_id=enterprise,
            enterprise_slug="acme",
            enterprise_code="acme-code",
            principal=principal(),
            idempotency_key="f01-1",
            request_fingerprint="fingerprint",
        )


def test_from_principal_accepts_dict_aliases_and_rejects_incomplete_or_wildcard_values():
    binding = OperatorTenantBindingRepository.from_principal(
        {
            "kid": "kid",
            "issuer": "issuer",
            "subject": "subject",
            "audience": ["audience"],
            "deployment_id": "deployment",
            "origin": "https://operator.example",
        },
        tenant_id="tenant",
        enterprise_id="enterprise",
    )
    assert binding.audience == "audience"
    for bad in ({"kid": "kid"}, {"kid": "*", "iss": "issuer", "sub": "subject", "aud": "audience", "deployment_id": "deployment", "origin": "https://operator.example"}):
        with pytest.raises(Forbidden):
            OperatorTenantBindingRepository.from_principal(bad, tenant_id="tenant", enterprise_id="enterprise")


def test_binding_get_and_require_exact_cover_missing_and_mismatch_paths():
    binding = OperatorTenantBindingRepository.from_principal(principal(), tenant_id="tenant", enterprise_id="enterprise")
    repo = OperatorTenantBindingRepository("postgresql://admin")
    matching = Connection(("tenant", "enterprise", "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"))
    with patch("psycopg.connect", return_value=matching):
        assert repo.get(tenant_id="tenant") == binding
    missing = Connection(None)
    with patch("psycopg.connect", return_value=missing), pytest.raises(NotFound):
        repo.get(tenant_id="tenant")

    repo.get = lambda **_kwargs: binding
    assert repo.require_exact(principal(), tenant_id="tenant") == binding
    with pytest.raises(Forbidden):
        repo.require_exact(principal(enterprise_id="enterprise"), tenant_id="tenant")
    with pytest.raises(Forbidden):
        repo.require_exact(principal(), tenant_id="tenant", enterprise_id="other", require_enterprise_claim=True)
    with pytest.raises(Forbidden):
        repo.require_exact(principal(enterprise_id="other"), tenant_id="tenant", enterprise_id="other", require_enterprise_claim=True)
    with pytest.raises(Forbidden):
        repo.require_exact(principal(), tenant_id="tenant", enterprise_id="other")


def test_ensure_binding_is_exact_and_f01_receipt_or_registry_failures_are_explicit():
    binding = OperatorTenantBindingRepository.from_principal(principal(), tenant_id="tenant", enterprise_id="enterprise")
    repo = OperatorTenantBindingRepository("postgresql://admin")
    inserted = Connection(("tenant",), ("tenant", "enterprise", "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"))
    with patch("psycopg.connect", return_value=inserted):
        repo.ensure_binding(binding)
    mismatch = Connection(None, ("tenant", "different", "operator-kid", "https://operator.example", "operator-service", "manager-service", "operator-deployment", "https://operator.example"))
    with patch("psycopg.connect", return_value=mismatch), pytest.raises(Conflict):
        repo.ensure_binding(binding)

    for rows in ((None, None), (None, ("f01", "other", "tenant", "enterprise", "acme", "code"))):
        connection = Connection(*rows)
        with patch("psycopg.connect", return_value=connection), pytest.raises((ManagerControlPlaneUnavailable, Conflict)):
            repo.ensure_registry_and_binding(
                tenant_id="tenant", enterprise_id="enterprise", enterprise_slug="acme", enterprise_code="code",
                principal=principal(), idempotency_key="f01", request_fingerprint="fp",
            )

    registry_missing = Connection(("f01", "fp", "tenant", "enterprise", "acme", "code"), ("tenant",), None)
    with patch("psycopg.connect", return_value=registry_missing), pytest.raises(ManagerControlPlaneUnavailable):
        repo.ensure_registry_and_binding(tenant_id="tenant", enterprise_id="enterprise", enterprise_slug="acme", enterprise_code="code", principal=None, idempotency_key="f01", request_fingerprint="fp")


def test_f01_signed_call_requires_key_and_fingerprint_together():
    repo = OperatorTenantBindingRepository("postgresql://admin")
    with pytest.raises(ValueError):
        repo.ensure_registry_and_binding(
            tenant_id="t", enterprise_id="e", enterprise_slug="acme", enterprise_code=None,
            principal=principal(), idempotency_key="f01-1",
        )
