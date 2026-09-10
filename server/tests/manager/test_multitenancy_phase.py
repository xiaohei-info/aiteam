from types import SimpleNamespace

import pytest

from manager_service.multitenancy_phase import MultitenancyPhasePending, require_control_plane_writes_ready


def test_onboarding_write_gate_requires_explicit_test_opt_in(monkeypatch):
    monkeypatch.delenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", raising=False)
    with pytest.raises(MultitenancyPhasePending):
        require_control_plane_writes_ready(SimpleNamespace(aiteam_env="test", test_onboarding_writes_enabled=False))
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    require_control_plane_writes_ready(SimpleNamespace(aiteam_env="test", test_onboarding_writes_enabled=True))
    with pytest.raises(MultitenancyPhasePending):
        require_control_plane_writes_ready(SimpleNamespace(aiteam_env="production"))


def test_onboarding_write_gate_does_not_use_untrusted_environment_without_settings(monkeypatch):
    monkeypatch.setenv("AITEAM_ENV", "test")
    monkeypatch.setenv("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", "true")
    with pytest.raises(MultitenancyPhasePending):
        require_control_plane_writes_ready(SimpleNamespace(aiteam_env="test", test_onboarding_writes_enabled=False))
