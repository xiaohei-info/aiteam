"""AITEAM-688 (M0): 部署级 runtime 固定 — 配置层生产标记校验。"""

from shared.config import Settings, load_settings


def test_is_production_true_when_aiteam_env_production():
    s = Settings(tier="agent", service_name="x", aiteam_env="production")
    assert s.is_production is True


def test_is_production_false_when_aiteam_env_dev():
    s = Settings(tier="agent", service_name="x", aiteam_env="dev")
    assert s.is_production is False


def test_is_production_false_when_aiteam_env_test():
    s = Settings(tier="agent", service_name="x", aiteam_env="test")
    assert s.is_production is False


def test_is_production_false_when_unset_defaults_to_dev():
    s = Settings(tier="agent", service_name="x")
    assert s.is_production is False


def test_load_settings_reads_aiteam_env(monkeypatch):
    monkeypatch.setenv("APP_TIER", "agent")
    monkeypatch.setenv("AITEAM_ENV", "production")
    s = load_settings()
    assert s.aiteam_env == "production"
    assert s.is_production is True
