from datetime import UTC, datetime

import pytest

from manager_service.provider_credential_service import ProviderCredentialService
from shared.contracts.platform_provider import PricingSnapshot
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ModelPolicy
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound


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
    snapshot = _Snapshot(); snapshot.status = status
    svc = ProviderCredentialService(object(), object(), snapshot, _Operator())
    with pytest.raises(NotFound):
        svc.runtime_config(TenantContext(tenant_id="t1", user_id="m1", roles=["member"]), employee_id="e1")


def test_runtime_config_fails_closed_without_pricing_snapshot():
    snapshot = _Snapshot(); snapshot.pricing = None
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
