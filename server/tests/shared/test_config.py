"""部署环境标记的配置层校验。"""

import logging

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


def test_is_production_false_when_unset_defaults_to_dev():
    s = Settings(tier="manager", service_name="x")
    assert s.is_production is False


def test_load_settings_reads_aiteam_env(monkeypatch):
    monkeypatch.setenv("APP_TIER", "manager")
    monkeypatch.setenv("AITEAM_ENV", "production")
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
