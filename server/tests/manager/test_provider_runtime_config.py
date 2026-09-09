from datetime import UTC, datetime

import pytest

from manager_service.provider_credential_service import ProviderCredentialService, _safe_runtime_relay_url
from shared.contracts.platform_provider import PricingSnapshot
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ModelPolicy
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound


def test_runtime_relay_url_rejects_unsafe_and_private_destinations(monkeypatch):
    monkeypatch.setenv("AITEAM_ENV", "production")
    with pytest.raises(NotFound):
        _safe_runtime_relay_url("https://user:secret@relay.example/v1")
    monkeypatch.setattr("manager_service.provider_credential_service.socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.2", 443))])
    with pytest.raises(NotFound):
        _safe_runtime_relay_url("https://relay.example/v1")
    monkeypatch.setattr("manager_service.provider_credential_service.socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    assert _safe_runtime_relay_url("https://relay.example/v1/") == "https://relay.example/v1"


class _Snapshot:
    status = "active"
    pricing = PricingSnapshot(
        pricing_version=1, pricing_status="known",
        input_usd_per_million="0.30", output_usd_per_million="1.20",
        cache_read_usd_per_million="0.06", effective_from=datetime.now(UTC),
    )

    def _ensure_runnable(self, ctx, *, employee_id):
        if self.status != "active":
            raise NotFound("employee is not runnable")

    def generate(self, ctx, *, member_id, employee_id):
        assert member_id == ctx.user_id
        return EmployeeExecutionSnapshot(
            employee_id=employee_id, version="1", snapshot_version="snap-1",
            model_policy=ModelPolicy(
                provider_ref="provider-1", provider_version=2,
                model="minimax-m3", model_version=3, pricing=self.pricing,
            ),
        )


class _Operator:
    def __init__(self): self.calls = []
    def list_platform_catalog(self):
        return {}
    def resolve_tenant_access(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "access": {"allowed_model_ids": ["minimax-m3"], "version": 4},
            "relay_base_url": "https://relay.test/v1",
            "api_protocol": "openai-completions",
            "relay_token": "tenant-scoped-token",
        }


def test_runtime_config_projects_non_sensitive_model_capabilities():
    operator = _Operator()
    operator.list_platform_catalog = lambda: {"models": [
        {"model": {"provider_id": "provider-1", "model_id": "minimax-m3", "version": 3, "capabilities": {
            "context_window": 96_000, "max_tokens": 8_192, "reasoning": True,
            "input_modalities": ["text", "image", "secret"], "thinking_level_map": {"high": "high", "low": None, "password": "no"},
        }}}
    ]}
    result = ProviderCredentialService(object(), object(), _Snapshot(), operator).runtime_config(
        TenantContext(tenant_id="t1", user_id="member-1", roles=["member"]), employee_id="employee-1",
    )
    assert result.model_capabilities == {
        "context_window": 96_000, "max_tokens": 8_192, "reasoning": True,
        "input": ["text", "image"], "thinking_level_map": {"high": "high", "low": None},
    }


def test_runtime_config_uses_operator_tenant_access_and_frozen_price():
    operator = _Operator()
    svc = ProviderCredentialService(object(), object(), _Snapshot(), operator)
    ctx = TenantContext(tenant_id="t1", user_id="member-1", roles=["member"])

    result = svc.runtime_config(ctx, employee_id="employee-1")

    assert result.model_dump(mode="json") == {
        "base_url": "https://relay.test/v1",
        "api_protocol": "openai-completions",
        "api_key": "tenant-scoped-token",
        "model": "minimax-m3",
        "provider_ref": "provider-1",
        "provider_version": 2,
        "model_version": 3,
        "pricing": result.pricing.model_dump(mode="json"),
        "version": 4,
        "model_capabilities": {},
    }
    assert operator.calls == [{"tenant_id": "t1", "provider_id": "provider-1", "model_ids": ["minimax-m3"]}]
    assert str(result.pricing.input_usd_per_million) == "0.30"


@pytest.mark.parametrize("status", ["draft", "provisioning", "paused", "provisioning_failed", "archived"])
def test_runtime_config_fails_closed_for_non_runnable_employee(status):
    snapshot = _Snapshot()
    snapshot.status = status
    svc = ProviderCredentialService(object(), object(), snapshot, _Operator())
    with pytest.raises(NotFound):
        svc.runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]), employee_id="e1")


def test_runtime_config_fails_closed_without_pricing_snapshot():
    snapshot = _Snapshot()
    snapshot.pricing = None
    svc = ProviderCredentialService(object(), object(), snapshot, _Operator())
    with pytest.raises(NotFound):
        svc.runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]), employee_id="e1")


def test_speech_runtime_config_is_tenant_scoped_and_does_not_require_employee():
    operator = _Operator()
    now = datetime.now(UTC)
    operator.list_platform_catalog = lambda *, tenant_id=None: {
        "providers": [{"provider_id": "provider-1", "version": 2}],
        "models": [{
            "model": {"provider_id": "provider-1", "model_id": "XingChenAGI/XingChenASR-V3.2-Ultra", "version": 3, "status": "published"},
            "rate": {"pricing_version": 1, "pricing_status": "known", "billing_mode": "request", "request_usd": "0", "currency": "USD", "effective_from": now},
        }],
    }
    def resolve_speech(**kwargs):
        operator.calls.append(kwargs)
        return {
            "access": {"allowed_model_ids": ["XingChenAGI/XingChenASR-V3.2-Ultra"], "version": 4},
            "relay_base_url": "https://relay.test/v1", "api_protocol": "openai-completions", "relay_token": "tenant-scoped-token",
        }
    operator.resolve_tenant_access = resolve_speech
    svc = ProviderCredentialService(object(), object(), _Snapshot(), operator)

    result = svc.speech_runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]))

    assert result.model == "XingChenAGI/XingChenASR-V3.2-Ultra"
    assert result.api_key == "tenant-scoped-token"
    assert result.pricing.billing_mode == "request"
    assert operator.calls == [{"tenant_id": "t1", "provider_id": "provider-1", "model_ids": ["XingChenAGI/XingChenASR-V3.2-Ultra"]}]


def test_speech_runtime_config_rejects_non_speech_models():
    operator = _Operator()
    operator.list_platform_catalog = lambda *, tenant_id=None: {
        "providers": [{"provider_id": "provider-1", "version": 2}],
        "models": [{
            "model": {"provider_id": "provider-1", "model_id": "minimax-m3", "version": 3, "status": "published"},
            "rate": {"pricing_version": 1, "pricing_status": "known", "effective_from": datetime.now(UTC)},
        }],
    }
    svc = ProviderCredentialService(object(), object(), _Snapshot(), operator)
    ctx = TenantContext(tenant_id="t1", user_id="m1", roles=["member"])

    with pytest.raises(NotFound):
        svc.speech_runtime_config(ctx, model="minimax-m3")


def _speech_catalog(*, model_id="custom-asr", model_status="published", rate=None):
    return {
        "providers": [{"provider_id": "provider-1", "version": 2}],
        "models": [{
            "model": {
                "provider_id": "provider-1", "model_id": model_id,
                "version": 3, "status": model_status,
            },
            "rate": rate or {
                "pricing_version": 1, "pricing_status": "known",
                "billing_mode": "request", "request_usd": "0",
                "currency": "USD", "effective_from": datetime.now(UTC),
            },
        }],
    }


def _speech_operator(catalog, *, resolve=None):
    class Operator:
        def list_platform_catalog(self, *, tenant_id=None):
            return catalog

        def resolve_tenant_access(self, **kwargs):
            if resolve is not None:
                return resolve(**kwargs)
            return {
                "access": {"allowed_model_ids": ["custom-asr"], "version": 4},
                "relay_base_url": "https://relay.test/v1",
                "api_protocol": "openai-completions",
                "relay_token": "tenant-scoped-token",
            }

    return Operator()


def test_speech_runtime_config_requires_operator_and_well_shaped_catalog():
    ctx = TenantContext(tenant_id="t1", user_id="m1", roles=["member"])
    with pytest.raises(NotFound, match="speech model is unavailable"):
        ProviderCredentialService(object(), object(), _Snapshot(), None).speech_runtime_config(ctx)

    class BadCatalog:
        def list_platform_catalog(self, *, tenant_id=None):
            return {"providers": [], "models": {}}

    with pytest.raises(NotFound, match="speech model is unavailable"):
        ProviderCredentialService(object(), object(), _Snapshot(), BadCatalog()).speech_runtime_config(ctx)


def test_speech_runtime_config_uses_generic_speech_fallback_and_legacy_catalog():
    catalog = _speech_catalog()

    class LegacyOperator:
        def list_platform_catalog(self):
            return catalog

        def resolve_tenant_access(self, **_kwargs):
            return {
                "access": {"allowed_model_ids": ["custom-asr"], "version": 4},
                "relay_base_url": "https://relay.test/v1",
                "api_protocol": "openai-completions",
                "relay_token": "tenant-scoped-token",
            }

    result = ProviderCredentialService(
        object(), object(), _Snapshot(), LegacyOperator()
    ).speech_runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]))
    assert result.model == "custom-asr"


def test_speech_runtime_config_rejects_invalid_model_metadata_and_access():
    ctx = TenantContext(tenant_id="t1", user_id="m1", roles=["member"])
    with pytest.raises(NotFound, match="speech model is unavailable"):
        ProviderCredentialService(
            object(), object(), _Snapshot(),
            _speech_operator(_speech_catalog(rate="invalid")),
        ).speech_runtime_config(ctx)

    with pytest.raises(NotFound, match="speech model not found"):
        ProviderCredentialService(
            object(), object(), _Snapshot(),
            _speech_operator(_speech_catalog(model_status="draft")),
        ).speech_runtime_config(ctx)

    with pytest.raises(NotFound, match="speech model not found"):
        ProviderCredentialService(
            object(), object(), _Snapshot(),
            _speech_operator(_speech_catalog(model_id=None)),
        ).speech_runtime_config(ctx)

    def deny(**_kwargs):
        return {
            "access": {"allowed_model_ids": [], "version": 4},
            "relay_base_url": "https://relay.test/v1",
            "api_protocol": "openai-completions",
            "relay_token": "tenant-scoped-token",
        }

    with pytest.raises(NotFound, match="speech model not found"):
        ProviderCredentialService(
            object(), object(), _Snapshot(),
            _speech_operator(_speech_catalog(), resolve=deny),
        ).speech_runtime_config(ctx)


def test_speech_runtime_config_hides_resolver_failures():
    def broken(**_kwargs):
        raise RuntimeError("relay unavailable")

    with pytest.raises(NotFound, match="speech model is unavailable"):
        ProviderCredentialService(
            object(), object(), _Snapshot(),
            _speech_operator(_speech_catalog(), resolve=broken),
        ).speech_runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]))


def test_runtime_config_hides_capability_catalog_failures():
    class BrokenOperator(_Operator):
        def list_platform_catalog(self, **_kwargs):
            raise RuntimeError("catalog unavailable")

    result = ProviderCredentialService(
        object(), object(), _Snapshot(), BrokenOperator()
    ).runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]), employee_id="e1")
    assert result.model_capabilities == {}
