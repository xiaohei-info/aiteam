import json


def test_post_json_includes_internal_auth_header(monkeypatch):
    from agent_gateway import webui_runtime_adapter as adapter

    captured = {}

    class _FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, *args, **kwargs):
            return b'{"session":{"session_id":"sess_123"}}'

    def _fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["headers"] = dict(req.header_items())
        captured["content_type"] = captured["headers"].get("Content-type")
        captured["internal_auth"] = captured["headers"].get("X-hermes-internal-auth")
        captured["body"] = req.data.decode("utf-8")
        return _FakeResponse()

    monkeypatch.setattr(adapter.urllib.request, "urlopen", _fake_urlopen)

    adapter._post_json("/api/session/new", {"profile": "taiyi-agent"})

    assert captured["url"].endswith("/api/session/new")
    assert captured["content_type"] == "application/json"
    assert captured["internal_auth"], "internal loopback call must carry X-Hermes-Internal-Auth"
    assert json.loads(captured["body"]) == {"profile": "taiyi-agent"}
