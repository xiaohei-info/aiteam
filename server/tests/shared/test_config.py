"""部署环境标记的配置层校验。"""

import logging

import pytest

from shared.config import Settings, load_settings


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


def test_production_load_settings_rejects_superuser_business_dsn(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://postgres:secret@localhost/manager")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    with pytest.raises(ValueError, match="DB_URL must use app_rw"):
        load_settings()


def test_load_settings_reads_aiteam_env(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
    monkeypatch.setenv("DB_URL", "postgresql://app_rw:secret@localhost/manager")
    monkeypatch.setenv("ADMIN_DB_URL", "postgresql://admin:secret@localhost/manager")
    monkeypatch.setenv("MANAGER_DB_NAME", "manager")
    s = load_settings()
    assert s.aiteam_env == "production"
    assert s.is_production is True


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
