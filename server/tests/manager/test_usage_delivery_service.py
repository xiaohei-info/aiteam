"""Manager delivery ServiceClient peer-audience call-site tests."""

from __future__ import annotations

from unittest.mock import patch

from manager_service.usage_delivery_service import build_usage_operator_delivery_service
from shared.config import Settings


class _FakeSignedClient:
    calls: list[dict] = []

    def __init__(self, base_url: str, **kwargs):
        self.base_url = base_url
        self.kwargs = kwargs
        self.calls.append({"base_url": base_url, **kwargs})

    def close(self):
        return None


def _settings(*, environment: str, service_token: str | None = "legacy-token"):
    return Settings(
        tier="manager",
        service_name="manager-service",
        db_url="postgresql://app_rw:password@manager/manager",
        admin_db_url="postgresql://admin:password@manager/manager",
        operator_url="https://operator.example",
        service_token=service_token,
        aiteam_env=environment,
    )


def test_production_delivery_uses_peer_audience_without_legacy_service_token():
    _FakeSignedClient.calls.clear()
    with patch("manager_service.usage_delivery_service.ServiceClient", _FakeSignedClient), \
         patch("manager_service.usage_delivery_service.service_peer_audience", return_value="aiteam-operation-service") as audience:
        service = build_usage_operator_delivery_service(_settings(environment="production", service_token="legacy-secret"))
    assert service is not None
    audience.assert_called_once()
    assert _FakeSignedClient.calls[0]["service_audience"] == "aiteam-operation-service"
    assert "service_token" not in _FakeSignedClient.calls[0]


def test_development_delivery_keeps_explicit_legacy_compatibility():
    _FakeSignedClient.calls.clear()
    with patch("manager_service.usage_delivery_service.ServiceClient", _FakeSignedClient), \
         patch("manager_service.usage_delivery_service.service_peer_audience", return_value="aiteam-operation-service"):
        service = build_usage_operator_delivery_service(_settings(environment="development", service_token="legacy-secret"))
    assert service is not None
    assert _FakeSignedClient.calls[0]["service_audience"] == "aiteam-operation-service"
    assert _FakeSignedClient.calls[0]["service_token"] == "legacy-secret"


def test_production_missing_peer_audience_fails_closed_even_with_legacy_token():
    _FakeSignedClient.calls.clear()
    with patch("manager_service.usage_delivery_service.ServiceClient", _FakeSignedClient), \
         patch("manager_service.usage_delivery_service.service_peer_audience", return_value=""):
        service = build_usage_operator_delivery_service(_settings(environment="production", service_token="legacy-secret"))
    assert service is None
    assert _FakeSignedClient.calls == []
