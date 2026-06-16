from types import SimpleNamespace


class _FakeHandler:
    def __init__(self, *, headers=None, client_ip="127.0.0.1"):
        self.status = None
        self.sent_headers = []
        self.body = bytearray()
        self.wfile = self
        self.headers = headers or {}
        self.client_address = (client_ip, 12345)

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def write(self, data):
        self.body.extend(data)


def test_internal_loopback_auth_allows_whitelisted_api_with_valid_header(monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "test-password")

    from api import auth

    auth._invalidate_password_hash_cache()
    token = auth.build_internal_auth_token("/api/session/new")
    handler = _FakeHandler(
        headers={"X-Hermes-Internal-Auth": token},
        client_ip="127.0.0.1",
    )

    assert auth.check_auth(handler, SimpleNamespace(path="/api/session/new", query="")) is True


def test_internal_loopback_auth_rejects_non_loopback_even_with_valid_header(monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "test-password")

    from api import auth

    auth._invalidate_password_hash_cache()
    token = auth.build_internal_auth_token("/api/session/new")
    handler = _FakeHandler(
        headers={"X-Hermes-Internal-Auth": token},
        client_ip="203.0.113.10",
    )

    assert auth.check_auth(handler, SimpleNamespace(path="/api/session/new", query="")) is False
    assert handler.status == 401


def test_internal_loopback_auth_rejects_non_whitelisted_api(monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_PASSWORD", "test-password")

    from api import auth

    auth._invalidate_password_hash_cache()
    token = auth.build_internal_auth_token("/api/settings")
    handler = _FakeHandler(
        headers={"X-Hermes-Internal-Auth": token},
        client_ip="127.0.0.1",
    )

    assert auth.check_auth(handler, SimpleNamespace(path="/api/settings", query="")) is False
    assert handler.status == 401

