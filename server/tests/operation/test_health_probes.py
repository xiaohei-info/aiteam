from types import SimpleNamespace

from operation_service import health_probes


def test_health_probe_builders_construct_and_check_with_signed_client_kwargs(monkeypatch):
    settings = SimpleNamespace(
        manager_url="https://manager.example.test",
        agent_url="http://127.0.0.1:8180",
    )
    signed_kwargs = {
        "service_identity": "operation-service",
        "service_token": None,
        "service_private_key": "private-key",
        "service_key_id": "operation-key",
        "service_audience": "peer-service",
        "service_auth_mode": "signed",
    }
    clients = []

    class FakeClient:
        def __init__(self, base_url, **kwargs):
            clients.append((base_url, kwargs))

        def get(self, path):
            assert path == "/healthz"
            return {"status": "ok"}

        def close(self):
            return None

    monkeypatch.setattr(health_probes, "load_settings", lambda _tier: settings)
    monkeypatch.setattr(health_probes, "service_client_kwargs", lambda _settings: signed_kwargs)
    monkeypatch.setattr(health_probes, "ServiceClient", FakeClient)

    manager = health_probes.build_manager_health_probe()
    agent = health_probes.build_agent_health_probe()

    assert manager is not None
    assert agent is not None
    assert manager.check() == "up"
    assert agent.check() == "up"
    assert [base_url for base_url, _kwargs in clients] == [settings.manager_url, settings.agent_url]
    assert all(kwargs["service_auth_mode"] == "signed" for _base_url, kwargs in clients)


def test_health_probe_builders_skip_unconfigured_urls(monkeypatch):
    settings = SimpleNamespace(manager_url=None, agent_url=None)
    monkeypatch.setattr(health_probes, "load_settings", lambda _tier: settings)
    monkeypatch.setattr(health_probes, "service_client_kwargs", lambda _settings: {})

    assert health_probes.build_manager_health_probe() is None
    assert health_probes.build_agent_health_probe() is None
