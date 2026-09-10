from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from operation_service.dependencies import get_provisioning_service
from operation_service.platform_provider_service import PlatformProviderService
from operation_service.repository import EnterpriseAccount, InMemoryEnterpriseRepository
from operation_service.service import ProvisioningService
from operation_service.schemas import ProvisionEnterpriseRequest
from run import get_app
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import Conflict, NotFound


REF = PlatformModelRef(
    provider_id="provider-1", provider_version=1, model_id="model-a", model_version=1,
)


class _Manager:
    def provision_tenant(self, req: TenantProvisionRequest, *, idempotency_key: str) -> None:
        self.provisioned = req

    def sync_owner_bootstrap(self, _req: OwnerBootstrapSync, *, idempotency_key: str) -> None:
        pass


def _token(role: str = "system_admin") -> str:
    from operation_service.app import _auth
    return _auth.signer.sign(TokenClaims(user_id="op-1", roles=[role], exp=9999999999))


def test_f01_same_key_and_body_replays_original_result_without_second_fanout():
    repository = InMemoryEnterpriseRepository()

    class RecordingManager(_Manager):
        def __init__(self):
            self.provision_calls = []
            self.bootstrap_calls = []

        def provision_tenant(self, req, *, idempotency_key):
            self.provision_calls.append((req, idempotency_key))

        def sync_owner_bootstrap(self, req, *, idempotency_key):
            self.bootstrap_calls.append((req, idempotency_key))

    manager = RecordingManager()
    service = ProvisioningService(repository, manager)
    request = ProvisionEnterpriseRequest(enterprise_name="ReplayCo", owner_phone="13800000000")
    first = service.provision_enterprise(request, idempotency_key="f01-replay")
    second = service.provision_enterprise(request, idempotency_key="f01-replay")

    assert second == first
    assert len(manager.provision_calls) == len(manager.bootstrap_calls) == 1
    with pytest.raises(Conflict):
        service.provision_enterprise(
            request.model_copy(update={"enterprise_name": "DifferentCo"}),
            idempotency_key="f01-replay",
        )


def test_provision_persists_and_forwards_allowed_model_refs():
    repository = InMemoryEnterpriseRepository()
    manager = _Manager()
    result = ProvisioningService(repository, manager).provision_enterprise(
        ProvisionEnterpriseRequest(
            enterprise_name="Acme", owner_phone="13800000000", allowed_model_refs=[REF],
        )
    )
    account = repository.get(result.enterprise_id)
    assert account.allowed_model_refs == [REF.model_dump(mode="json")]
    assert manager.provisioned.allowed_model_refs == [REF]
    assert result.allowed_model_refs == [REF]


def test_model_access_deduplicates_refs_and_validates_published_models():
    repository = InMemoryEnterpriseRepository()
    repository.create(EnterpriseAccount(
        enterprise_id="enterprise-1", tenant_id="tenant-1", enterprise_name="Acme",
        enterprise_code=None, owner_phone="1", owner_bootstrap_hash="hash",
    ))

    class Validator:
        def __init__(self):
            self.calls = []

        def validate_model_ref(self, ref, *, require_published):
            self.calls.append((ref, require_published))

    validator = Validator()
    service = ProvisioningService(repository, _Manager(), platform_provider_service=validator)
    updated = service.set_model_access("enterprise-1", [REF, REF])

    assert updated.allowed_model_refs == [REF]
    assert validator.calls == [(REF, True), (REF, True)]


def test_model_access_lookup_handles_legacy_enterprise_repositories():
    repository = InMemoryEnterpriseRepository()
    with pytest.raises(NotFound, match="enterprise not found"):
        repository.get_by_tenant_id("tenant-1")

    service = PlatformProviderService(
        None, None, None, "https://relay.test/v1", enterprise_repository=object()
    )
    assert service._allowed_model_refs("tenant-1") is None

    class MissingEnterprise:
        def get_by_tenant_id(self, _tenant_id):
            raise NotFound("missing tenant")

    service = PlatformProviderService(
        None, None, None, "https://relay.test/v1", enterprise_repository=MissingEnterprise()
    )
    assert service._allowed_model_refs("tenant-1") == []


def test_model_access_route_reads_and_updates_allow_list():
    app = get_app("operation")
    repository = InMemoryEnterpriseRepository()
    enterprise_id = "enterprise-1"
    repository.create(EnterpriseAccount(
        enterprise_id=enterprise_id, tenant_id="tenant-1", enterprise_name="Acme",
        enterprise_code=None, owner_phone="13800000000", owner_bootstrap_hash="hash",
        allowed_model_refs=[REF.model_dump(mode="json")],
    ))
    manager = _Manager()
    service = ProvisioningService(repository, manager)
    app.dependency_overrides[get_provisioning_service] = lambda: service
    try:
        client = TestClient(app)
        headers = {"Authorization": f"Bearer {_token()}"}
        read = client.get(f"/api/operation/admin/enterprises/{enterprise_id}/model-access", headers=headers)
        assert read.status_code == 200
        assert read.json()["data"]["allowed_model_refs"][0]["model_id"] == "model-a"

        updated = client.patch(
            f"/api/operation/admin/enterprises/{enterprise_id}/model-access",
            headers=headers,
            json={"allowed_model_refs": []},
        )
        assert updated.status_code == 200
        assert updated.json()["data"]["allowed_model_refs"] == []
        assert repository.get(enterprise_id).allowed_model_refs == []
    finally:
        app.dependency_overrides.clear()


def test_platform_catalog_and_tenant_access_hide_unopened_models():
    now = datetime.now(UTC)
    provider = type("Provider", (), {
        "provider_id": "provider-1", "provider_code": "newapi", "display_name": "LLM 网关",
        "relay_base_url": "https://relay.test/v1", "api_protocol": "openai-completions",
        "newapi_channel_id": 1, "status": "published", "version": 1, "updated_at": now,
    })()
    allowed_model = type("Model", (), {
        "provider_id": "provider-1", "model_id": "model-a", "display_name": "A",
        "capabilities": {"thinking_mode": "none", "thinking_levels": ["off"]}, "status": "published", "source": "discovery", "version": 1,
        "updated_at": now,
    })()
    blocked_model = type("Model", (), {
        "provider_id": "provider-1", "model_id": "model-b", "display_name": "B",
        "capabilities": {"thinking_mode": "none", "thinking_levels": ["off"]}, "status": "published", "source": "discovery", "version": 1,
        "updated_at": now,
    })()

    class _ProviderRepo:
        def ensure_internal_provider(self, **_): return provider
        def list_providers(self, **_): return [provider]
        def get_provider(self, _): return provider
        def list_models(self, _provider_id, **_): return [allowed_model, blocked_model]
        def get_access(self, _tenant_id, _provider_id): return None
        def current_rate(self, _provider_id, _model_id):
            return type("Rate", (), {
                "rate_id": "r", "provider_id": "provider-1", "model_id": "model-a",
                "pricing_version": 1, "pricing_status": "known", "billing_mode": "token",
                "input_usd_per_million": 1, "output_usd_per_million": 2,
                "cache_read_usd_per_million": None, "cache_write_usd_per_million": None,
                "request_usd": None, "currency": "USD", "source": "manual", "source_version": None,
                "effective_from": now, "effective_to": None, "manually_overridden": True,
            })()

    enterprise = InMemoryEnterpriseRepository()
    enterprise.create(EnterpriseAccount(
        enterprise_id="enterprise-1", tenant_id="tenant-1", enterprise_name="Acme",
        enterprise_code=None, owner_phone="1", owner_bootstrap_hash="h",
        allowed_model_refs=[REF.model_dump(mode="json")],
    ))
    service = PlatformProviderService(_ProviderRepo(), None, None, "https://relay.test/v1", enterprise_repository=enterprise)
    service.ensure_internal_provider = lambda **_: None
    catalog = service.list_platform_catalog(tenant_id="tenant-1")
    assert [item["model"].model_id for item in catalog["models"]] == ["model-a"]
    assert catalog["model_access_configured"] is True
    with pytest.raises(NotFound, match="platform model not found"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="provider-1", model_ids=["model-b"])
    # The allowed path refreshes the enterprise-filtered list before provisioning
    # a new relay access record (the fake omits NewAPI, so it stops afterward).
    with pytest.raises(AttributeError):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="provider-1", model_ids=["model-a"])


def test_platform_provider_builder_wires_enterprise_repository(monkeypatch):
    import operation_service.platform_provider_service as module
    import operation_service.repository as repository_module

    monkeypatch.setenv("DB_URL", "postgresql://app_rw.test/operation")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin.test/operation")
    monkeypatch.setenv("OPERATION_DB_URL", "postgresql://app_rw.test/operation")
    monkeypatch.setenv("OPERATION_ADMIN_DB_URL", "postgresql://admin.test/operation")
    monkeypatch.setenv("NEWAPI_URL", "http://newapi.test")
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "https://relay.test/v1")
    monkeypatch.setenv("NEWAPI_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("NEWAPI_ADMIN_USER_ID", "1")
    monkeypatch.setenv("OPERATION_PROVIDER_CREDENTIAL_KEY", "test-key")
    enterprise = object()
    monkeypatch.setattr(repository_module, "PgEnterpriseRepository", lambda dsn: enterprise)
    monkeypatch.setattr(module, "PlatformProviderRepository", lambda dsn: ("provider", dsn))
    monkeypatch.setattr(module, "NewApiAdminClient", lambda *args, **kwargs: ("newapi", args, kwargs))
    monkeypatch.setattr(module, "CryptoService", lambda *_args, **_kwargs: "crypto")
    monkeypatch.setattr(module, "ModelsDevPricingClient", lambda *args, **kwargs: ("pricing", args, kwargs))
    monkeypatch.setattr(module, "Fernet", lambda _key: "fernet")
    module.build_platform_provider_service.cache_clear()
    try:
        service = module.build_platform_provider_service()
    finally:
        module.build_platform_provider_service.cache_clear()

    assert service._enterprise is enterprise
