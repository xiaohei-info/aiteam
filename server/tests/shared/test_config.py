"""部署环境标记的配置层校验。"""

import json
import logging
import time

import pytest

from shared.auth import generate_rsa_keypair
from shared.config import (
    Settings,
    _boolean,
    _json_mapping,
    _service_auth_mode,
    _service_identity_clock_skew,
    _service_identity_ttl,
    load_settings,
    service_client_kwargs,
)


def test_service_client_kwargs_use_validated_tier_signer_inputs():
    settings = Settings(
        tier="operation",
        service_name="operation",
        service_identity_private_key="private",
        service_identity_key_id="kid",
        service_identity_issuer="issuer",
        service_identity_deployment_id="deployment",
        service_identity_peer_audience="manager-audience",
        service_identity_origin="https://operation.example",
        service_auth_mode="signed",
        aiteam_env="test",
        service_token="test-token",
    )
    kwargs = service_client_kwargs(settings)
    assert kwargs["service_private_key"] == "private"
    assert kwargs["service_key_id"] == "kid"
    assert kwargs["service_issuer"] == "issuer"
    assert kwargs["service_deployment_id"] == "deployment"
    assert kwargs["service_audience"] == "manager-audience"
    assert kwargs["service_origin"] == "https://operation.example"
    assert kwargs["load_env_signer"] is False


def test_service_identity_config_parsers_reject_malformed_values(monkeypatch):
    monkeypatch.setenv("SERVICE_AUTH_MODE", "unsupported")
    with pytest.raises(ValueError):
        _service_auth_mode()
    monkeypatch.setenv("SERVICE_IDENTITY_TTL_SECONDS", "bad")
    with pytest.raises(ValueError):
        _service_identity_ttl()
    monkeypatch.setenv("SERVICE_IDENTITY_TTL_SECONDS", "0")
    with pytest.raises(ValueError):
        _service_identity_ttl()
    monkeypatch.setenv("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS", "bad")
    with pytest.raises(ValueError):
        _service_identity_clock_skew()
    monkeypatch.setenv("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS", "31")
    with pytest.raises(ValueError):
        _service_identity_clock_skew()
    monkeypatch.setenv("BOOLEAN", "false")
    assert _boolean("BOOLEAN") is False
    monkeypatch.setenv("BOOLEAN", "maybe")
    with pytest.raises(ValueError):
        _boolean("BOOLEAN")
    monkeypatch.setenv("MAPPING", "[]")
    with pytest.raises(ValueError):
        _json_mapping("MAPPING")
    monkeypatch.setenv("MAPPING", "not-json")
    with pytest.raises(ValueError):
        _json_mapping("MAPPING")


def test_is_production_true_when_aiteam_env_production():
    s = Settings(tier="manager", service_name="x", aiteam_env="production")
    assert s.is_production is True


def test_is_production_false_when_aiteam_env_dev():
    s = Settings(tier="manager", service_name="x", aiteam_env="dev")
    assert s.is_production is False


def test_is_production_false_when_aiteam_env_test():
    s = Settings(tier="manager", service_name="x", aiteam_env="test")
    assert s.is_production is False


def test_unknown_aiteam_env_is_rejected():
    with pytest.raises(ValueError):
        Settings(tier="manager", service_name="x", aiteam_env="prod")


def test_is_production_false_when_unset_defaults_to_dev():
    s = Settings(tier="manager", service_name="x")
    assert s.is_production is False


def test_load_settings_requires_explicit_environment(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.delenv("AITEAM_ENV", raising=False)
    with pytest.raises(ValueError, match="AITEAM_ENV must be explicitly set"):
        load_settings()


def test_load_settings_rejects_unknown_environment(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "Production")
    with pytest.raises(ValueError, match="AITEAM_ENV must be one of"):
        load_settings()


def test_load_settings_rejects_malformed_production_dsn(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw:secret@[bad")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    with pytest.raises(ValueError, match="valid PostgreSQL URLs"):
        load_settings()


def test_operation_settings_prefer_tier_specific_database_urls(monkeypatch):
    monkeypatch.setenv("APP_TIER", "operation")
    monkeypatch.setenv("AITEAM_ENV", "test")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@manager/manager_control_db")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@manager/manager_control_db")
    monkeypatch.setenv("OPERATION_DB_URL", "postgresql://app_rw@operation/oper")
    monkeypatch.setenv("OPERATION_ADMIN_DB_URL", "postgresql://admin@operation/oper")
    settings = load_settings()
    assert settings.db_url.endswith("/oper")
    assert settings.admin_db_url.endswith("/oper")


def test_operation_test_database_requires_tier_specific_urls(monkeypatch):
    monkeypatch.setenv("APP_TIER", "operation")
    monkeypatch.setenv("AITEAM_ENV", "test")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw@manager/manager_control_db")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin@manager/manager_control_db")
    monkeypatch.delenv("OPERATION_DB_URL", raising=False)
    monkeypatch.delenv("OPERATION_ADMIN_DB_URL", raising=False)
    with pytest.raises(ValueError, match="Operation requires OPERATION_DB_URL"):
        load_settings()


def test_production_load_settings_rejects_missing_signed_service_identity(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw:secret@localhost/manager")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    monkeypatch.setenv("MANAGER_DB_NAME", "manager")
    monkeypatch.setenv("OPERATOR_URL", "https://operation.example")
    for name in (
        "SERVICE_AUTH_MODE",
        "SERVICE_IDENTITY_PRIVATE_KEY",
        "SERVICE_IDENTITY_KEY_ID",
        "SERVICE_IDENTITY_ISSUER",
        "SERVICE_IDENTITY_AUDIENCE",
        "SERVICE_IDENTITY_PEER_AUDIENCE",
        "SERVICE_IDENTITY_ORIGIN",
        "SERVICE_IDENTITY_DEPLOYMENT_ID",
        "SERVICE_IDENTITY_TRUST_JSON",
        "SERVICE_IDENTITY_SINGLE_INSTANCE",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="production service authentication"):
        load_settings()


def test_production_load_settings_rejects_superuser_business_dsn(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://postgres:secret@localhost/manager")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    with pytest.raises(ValueError, match="DB_URL must use app_rw"):
        load_settings()


def test_load_settings_reads_aiteam_env_with_signed_service_identity(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw:secret@localhost/manager")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    monkeypatch.setenv("MANAGER_DB_NAME", "manager")
    private_key, public_key = generate_rsa_keypair()
    now = int(time.time())
    monkeypatch.setenv("MANAGER_SERVICE_AUTH_MODE", "signed")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_PRIVATE_KEY", private_key)
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_KEY_ID", "manager-key")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_ISSUER", "https://manager.example/service-issuer")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_AUDIENCE", "aiteam-manager-service")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_PEER_AUDIENCE", "aiteam-operation-service")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_ORIGIN", "https://manager.example")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_DEPLOYMENT_ID", "manager-deployment")
    monkeypatch.setenv("MANAGER_SERVICE_IDENTITY_SINGLE_INSTANCE", "true")
    monkeypatch.setenv("OPERATOR_URL", "https://operation.example")
    monkeypatch.setenv(
        "MANAGER_SERVICE_IDENTITY_TRUST_JSON",
        json.dumps(
            {
                "operation-key": {
                    "public_key": public_key,
                    "issuer": "https://operation.example/service-issuer",
                    "subject": "operation-service",
                    "deployment_id": "operation-deployment",
                    "status": "active",
                    "not_before": now - 60,
                    "expires_at": now + 3600,
                    "audiences": ["aiteam-manager-service"],
                    "origins": ["https://manager.example"],
                    "scopes": ["enterprise:provision"],
                    "provisioning_capabilities": ["provision-enterprise"],
                    "target_bindings": [
                        {"enterprise_id": "enterprise-a", "origin": "https://manager.example"}
                    ],
                }
            }
        ),
    )
    s = load_settings()
    assert s.aiteam_env == "production"
    assert s.is_production is True
    assert s.service_auth_mode == "signed"
    assert s.service_identity_single_instance is True


def test_load_settings_warns_and_ignores_legacy_manager_tenant_id(monkeypatch, caplog):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("MANAGER_TENANT_ID", "00000000-0000-4000-8000-000000000001")
    caplog.set_level(logging.WARNING)
    s = load_settings()
    assert not hasattr(s, "manager_tenant_id")
    assert "MANAGER_TENANT_ID is ignored" in caplog.text


def test_load_settings_ignores_whitespace_manager_tenant_id_without_warning(monkeypatch, caplog):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("MANAGER_TENANT_ID", "   ")
    caplog.set_level(logging.WARNING)
    s = load_settings()
    assert not hasattr(s, "manager_tenant_id")
    assert "MANAGER_TENANT_ID is ignored" not in caplog.text
