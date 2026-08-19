from types import SimpleNamespace

import pytest

from manager_service.provider_credential_service import ProviderCredentialService
from manager_service.schemas_provider import ProviderCredentialCreate
from shared.contracts.tenancy import TenantContext
from shared.crypto import CryptoService
from shared.errors import NotFound


class _Repo:
    def __init__(self):
        self.row = None

    def get_by_ref(self, ctx, *, provider_ref):
        return self.row if self.row and self.row.provider_ref == provider_ref else None

    def get(self, ctx, *, credential_id):
        return self.row if self.row and self.row.credential_id == credential_id else None

    def create(self, ctx, **kwargs):
        from manager_service.provider_credential_repository import ProviderCredentialRow
        self.row = ProviderCredentialRow(
            credential_id="c1", provider_ref=kwargs["provider_ref"], display_name="p",
            endpoint=kwargs["endpoint"], api_protocol=kwargs["api_protocol"],
            encrypted_secret=kwargs["encrypted_secret"], visibility=kwargs["visibility"],
            allowed_member_ids=kwargs["allowed_member_ids"], supported_models=kwargs["supported_models"],
            model_catalog_source="manual", version=1,
        )
        return self.row


class _Snapshot:
    status = "active"

    def _ensure_runnable(self, ctx, *, employee_id):
        if self.status != "active":
            raise NotFound("employee is not runnable")

    def generate(self, ctx, *, member_id, employee_id):
        assert member_id == ctx.user_id
        return SimpleNamespace(model_policy=SimpleNamespace(provider_ref="p1", model="m1"))


def test_runtime_config_is_employee_scoped_and_secret_only_on_runtime_endpoint():
    from cryptography.fernet import Fernet

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    repo = _Repo()
    svc = ProviderCredentialService(repo, crypto, _Snapshot())
    svc.create(
        TenantContext(tenant_id="t1", user_id="member-1", roles=["owner"]),
        ProviderCredentialCreate(
            provider_ref="p1", endpoint="https://newapi.test/v1", secret="secret",
            supported_models=[{"model": "m1", "enabled": True}],
        ),
    )
    result = svc.runtime_config(TenantContext(tenant_id="t1", user_id="member-1", roles=["member"]), employee_id="employee-1")
    assert result.model_dump() == {
        "base_url": "https://newapi.test/v1", "api_protocol": "openai-completions",
        "api_key": "secret", "model": "m1", "provider_ref": "p1", "version": 1,
    }
    assert "api_key" not in svc.get(TenantContext(tenant_id="t1", user_id="member-1", roles=["member"]), credential_id="c1").model_dump()


def test_runtime_config_respects_member_visibility():
    from cryptography.fernet import Fernet

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    repo = _Repo()
    snapshot = _Snapshot()
    svc = ProviderCredentialService(repo, crypto, snapshot)
    svc.create(
        TenantContext(tenant_id="t1", user_id="owner-1", roles=["owner"]),
        ProviderCredentialCreate(
            provider_ref="p1", endpoint="https://newapi.test/v1", secret="secret",
            visibility="members", allowed_member_ids=["member-allowed"],
            supported_models=[{"model": "m1", "enabled": True}],
        ),
    )
    with pytest.raises(NotFound):
        svc.runtime_config(
            TenantContext(tenant_id="t1", user_id="member-denied", roles=["member"]),
            employee_id="employee-1",
        )
    assert svc.runtime_config(
        TenantContext(tenant_id="t1", user_id="member-allowed", roles=["member"]),
        employee_id="employee-1",
    ).api_key == "secret"


@pytest.mark.parametrize("status", ["draft", "provisioning", "paused", "provisioning_failed", "archived"])
def test_runtime_config_fails_closed_for_non_runnable_employee(status):
    from cryptography.fernet import Fernet

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    repo = _Repo()
    snapshot = _Snapshot()
    snapshot.status = status
    svc = ProviderCredentialService(repo, crypto, snapshot)
    with pytest.raises(NotFound):
        svc.runtime_config(
            TenantContext(tenant_id="t1", user_id="member-1", roles=["member"]),
            employee_id="employee-1",
        )


def test_runtime_config_fails_closed_when_model_is_not_enabled():
    from cryptography.fernet import Fernet

    crypto = CryptoService(Fernet(Fernet.generate_key()))
    repo = _Repo()
    svc = ProviderCredentialService(repo, crypto, _Snapshot())
    svc.create(
        TenantContext(tenant_id="t1", user_id="member-1", roles=["owner"]),
        ProviderCredentialCreate(provider_ref="p1", endpoint="https://newapi.test/v1", secret="secret"),
    )
    with pytest.raises(NotFound):
        svc.runtime_config(TenantContext(tenant_id="t1", user_id="member-1", roles=["member"]), employee_id="employee-1")
