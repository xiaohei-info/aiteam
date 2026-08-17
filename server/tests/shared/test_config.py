"""部署环境标记的配置层校验。"""

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
