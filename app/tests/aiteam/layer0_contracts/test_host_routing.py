"""Layer 0 host routing tests — namespace dispatch and regression.

Team Panel paths now return real data after L2-S06.  Admin namespaces
remain 501 stubs.  Existing host APIs must still work.
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error
from urllib.parse import urlparse


# ── FakeHandler (mirrors test_gateway_status_agent_health._FakeHandler) ──

class _FakeHandler:
    """Minimal BaseHTTPRequestHandler stand-in for routes.handle_get and handle_post."""

    def __init__(self):
        self.status = None
        self.sent_headers: list[tuple[str, str]] = []
        self.body = bytearray()
        self.wfile = self
        self.headers = {}  # for read_body/content-length
        self.rfile = None

    def send_response(self, code):
        self.status = code

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def write(self, data):
        self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

    def get_json(self):
        return json.loads(self.body.decode("utf-8"))


def _get(parsed_path: str) -> tuple[int, dict]:
    """Call handle_get with a FakeHandler and return (status, response_json)."""
    from api.routes import handle_get
    handler = _FakeHandler()
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_get(handler, parsed)
    return handler.status, handler.get_json()


def _post(parsed_path: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, dict]:
    """Call handle_post with a FakeHandler and return (status, response_json)."""
    from api.routes import handle_post
    handler = _FakeHandler()
    if headers:
        handler.headers.update(headers)
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        handler.headers["Content-Length"] = str(len(raw))
        handler.rfile = type("_BytesIO", (), {"read": lambda self, n: raw})()
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_post(handler, parsed)
    return handler.status, handler.get_json()


def _patch(parsed_path: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, dict]:
    """Call handle_patch with a FakeHandler and return (status, response_json)."""
    from api.routes import handle_patch
    handler = _FakeHandler()
    if headers:
        handler.headers.update(headers)
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        handler.headers["Content-Length"] = str(len(raw))
        handler.rfile = type("_BytesIO", (), {"read": lambda self, n: raw})()
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_patch(handler, parsed)
    return handler.status, handler.get_json()


def _delete(parsed_path: str, headers: dict | None = None) -> tuple[int, dict]:
    """Call handle_delete with a FakeHandler and return (status, response_json)."""
    from api.routes import handle_delete
    handler = _FakeHandler()
    if headers:
        handler.headers.update(headers)
    parsed = urlparse(f"http://example.com{parsed_path}")
    handle_delete(handler, parsed)
    return handler.status, handler.get_json()


# ── S02-T01: /api/team/* dispatches to Team router (L2-S06: real data) ──

def test_team_namespace_known_routes_return_503_when_db_unavailable(monkeypatch):
    """Known team GET/POST/PATCH routes should surface DB outages as 503."""
    import team_panel.api_team.router_team as router_team

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(router_team, "_make_conn", _boom)

    checks = [
        ("GET", "/api/team/workbench", None),
        ("GET", "/api/team/office/scene", None),
        ("GET", "/api/team/office/feed", None),
        ("GET", "/api/team/org/tree", None),
        ("POST", "/api/team/runs", {}),
        ("PATCH", "/api/team/employees/nonexistent_emp", {"name": "test"}),
        ("PATCH", "/api/team/org/assignments/nonexistent_emp", {"department_id": "dept_marketing"}),
    ]

    for method, path, payload in checks:
        if method == "GET":
            status, body = _get(path)
        elif method == "POST":
            status, body = _post(path, payload)
        else:
            status, body = _patch(path, payload)
        assert status == 503, f"{method} {path}: expected 503, got {status}: {body}"
        assert body.get("error") == "database_unavailable"
        assert body.get("error") != "not_implemented"


def test_team_namespace_unknown_paths_stay_501_when_db_unavailable(monkeypatch):
    """Unknown team paths must stay not_implemented even if the DB is down."""
    import team_panel.api_team.router_team as router_team

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(router_team, "_make_conn", _boom)

    checks = [
        ("GET", "/api/team/unknown-endpoint", None),
        ("POST", "/api/team/unknown-endpoint", {}),
        ("PATCH", "/api/team/unknown-endpoint", {}),
    ]

    for method, path, payload in checks:
        if method == "GET":
            status, body = _get(path)
        elif method == "POST":
            status, body = _post(path, payload)
        else:
            status, body = _patch(path, payload)
        assert status == 501, f"{method} {path}: expected 501, got {status}: {body}"
        assert body.get("error") == "not_implemented"


def test_team_namespace_post_checks_csrf_before_body_read(monkeypatch):
    import api.routes as routes

    read_calls = 0

    def _read_body(_handler):
        nonlocal read_calls
        read_calls += 1
        return {}

    monkeypatch.setattr(routes, "_check_csrf", lambda handler: False)
    monkeypatch.setattr(routes, "read_body", _read_body)

    status, body = _post(
        "/api/team/runs",
        {},
        headers={"Origin": "https://evil.example", "Host": "example.com"},
    )
    assert status == 403
    assert body.get("error") == "Cross-origin request rejected"
    assert read_calls == 0


def test_team_namespace_patch_checks_csrf_before_body_read(monkeypatch):
    import api.routes as routes

    read_calls = 0

    def _read_body(_handler):
        nonlocal read_calls
        read_calls += 1
        return {}

    monkeypatch.setattr(routes, "_check_csrf", lambda handler: False)
    monkeypatch.setattr(routes, "read_body", _read_body)

    status, body = _patch(
        "/api/team/employees/nonexistent_emp",
        {"name": "test"},
        headers={"Origin": "https://evil.example", "Host": "example.com"},
    )
    assert status == 403
    assert body.get("error") == "Cross-origin request rejected"
    assert read_calls == 0


def test_auth_northbound_routes_no_longer_return_404_or_501():
    checks = [
        ("GET", "/api/auth/login/wechat/poll?state=missing", None),
        ("GET", "/api/me", None),
        ("POST", "/api/auth/login/wechat/init", {}),
        ("POST", "/api/auth/login/wechat/callback", {"state": "missing", "code": "bad"}),
        ("POST", "/api/auth/login/phone/send-code", {"phone": "13800138000"}),
        ("POST", "/api/auth/login/phone/verify", {"phone": "13800138000", "code": "bad"}),
        ("POST", "/api/auth/refresh", {}),
        ("POST", "/api/auth/logout", {}),
    ]

    for method, path, payload in checks:
        if method == "GET":
            status, body = _get(path)
        else:
            status, body = _post(path, payload)
        assert status != 501, f"{method} {path}: expected host dispatch to handle route, got {status}: {body}"


# ── S02-T02: admin namespaces route real endpoints and keep stubs for unknowns ──

def test_enterprise_admin_known_namespace_routes_return_real_json():
    """Known enterprise-admin GET routes should no longer return the 501 stub."""
    for path in [
        "/api/enterprise-admin/employees?role=owner",
        "/api/enterprise-admin/billing/usage?role=owner",
        "/api/enterprise-admin/invites?role=owner",
    ]:
        status, body = _get(path)
        assert status != 501, f"GET {path}: should not be 501 stub, got {status}: {body}"
        assert body.get("error") != "not_implemented"


def test_team_known_b08_b09_routes_return_real_json_or_503():
    """New B08/B09 Team routes should no longer fall through to the 501 stub."""
    for path in [
        "/api/team/settings",
        "/api/team/billing/balance",
        "/api/team/billing/recharges",
    ]:
        status, body = _get(path)
        assert status != 501, f"GET {path}: should not be 501 stub, got {status}: {body}"
        assert body.get("error") != "not_implemented"


def test_enterprise_admin_known_route_db_unavailable_returns_503(monkeypatch):
    import team_panel.api_team.router_enterprise_admin as router_enterprise_admin

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(router_enterprise_admin, "_make_conn", _boom)
    status, body = _get("/api/enterprise-admin/employees")
    assert status == 503, body
    assert body.get("error") == "database_unavailable"
    assert body.get("error") != "not_implemented"


def test_enterprise_admin_unknown_namespace_stays_501_when_db_unavailable(monkeypatch):
    import team_panel.api_team.router_enterprise_admin as router_enterprise_admin

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(router_enterprise_admin, "_make_conn", _boom)
    status, body = _get("/api/enterprise-admin/dashboard")
    assert status == 501, body
    assert body.get("error") == "not_implemented"


def test_system_admin_known_namespace_routes_return_real_json():
    """Known system-admin GET routes should no longer return the 501 stub."""
    for path in [
        "/api/system-admin/health",
        "/api/system-admin/templates",
        "/api/system-admin/solutions",
        "/api/system-admin/finance/overview",
        "/api/system-admin/finance/reports",
    ]:
        status, body = _get(path)
        assert status != 501, f"GET {path}: should not be 501 stub, got {status}: {body}"
        assert body.get("error") != "not_implemented"


def test_enterprise_admin_unknown_namespace_still_returns_501_json():
    """Unknown enterprise-admin paths still return 501 JSON."""
    for path in [
        "/api/enterprise-admin/dashboard",
        "/api/enterprise-admin/members",
    ]:
        status, body = _get(path)
        assert status == 501, f"GET {path}: expected 501, got {status}: {body}"
        assert body.get("error") == "not_implemented"


def test_system_admin_unknown_namespace_still_returns_501_json():
    """Unknown system-admin paths still return 501 JSON."""
    for path in [
        "/api/system-admin/tenants",
        "/api/system-admin/operators",
    ]:
        status, body = _get(path)
        assert status == 501, f"GET {path}: expected 501, got {status}: {body}"
        assert body.get("error") == "not_implemented"


def test_enterprise_admin_invites_post_returns_real_json():
    payload = {
        "phone": "13900003333",
        "role": "enterprise_admin",
        "permissions": {"employees": True},
        "idempotency_key": "enterprise-admin-invite-001",
    }
    status, body = _post("/api/enterprise-admin/invites", payload)
    assert status != 501, body
    assert body.get("error") != "not_implemented"


def test_enterprise_admin_invites_delete_returns_real_json():
    delete_status, delete_body = _delete("/api/enterprise-admin/invites/invite_probe")
    assert delete_status != 501, delete_body
    assert delete_body.get("error") != "not_implemented"


def test_enterprise_admin_unknown_post_still_returns_501_json():
    """Unknown POST /api/enterprise-admin/* must still return 501 JSON."""
    status, body = _post("/api/enterprise-admin/members", {})
    assert status == 501
    assert body.get("error") == "not_implemented"


def test_system_admin_known_route_db_unavailable_returns_503(monkeypatch):
    import team_panel.api_team.router_system_admin as router_system_admin

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(router_system_admin, "_make_conn", _boom)
    status, body = _get("/api/system-admin/templates")
    assert status == 503, body
    assert body.get("error") == "database_unavailable"


def test_system_admin_namespace_post_returns_501_json():
    """Unknown POST /api/system-admin/* must still return 501 JSON."""
    status, body = _post("/api/system-admin/tenants", {})
    assert status == 501
    assert body.get("error") == "not_implemented"


# ── S02-T07: Regression — old host APIs still work ───────────────────────

def test_health_endpoint_still_works(test_server, base_url):
    """GET /health must still return status=ok."""
    url = f"{base_url}/health"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        data = json.loads(e.read())
        raise AssertionError(f"/health returned HTTP {e.code}: {data}")
    assert data.get("status") == "ok", f"/health response: {data}"


def test_existing_session_api_still_works(test_server, cleanup_test_sessions, base_url):
    """GET /api/session with a valid session_id must still work (not hijacked by dispatch)."""

    # Create a session first
    req = urllib.request.Request(
        base_url + "/api/session/new",
        data=json.dumps({}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        new_data = json.loads(r.read())
        sid = new_data["session"]["session_id"]
        cleanup_test_sessions.append(sid)

    # Now GET the session
    url = f"{base_url}/api/session?session_id={sid}"
    with urllib.request.urlopen(url, timeout=10) as r:
        data = json.loads(r.read())
    assert "session" in data, f"/api/session response: {data}"
    assert data["session"]["session_id"] == sid


# ── Additional: verify dispatch does NOT intercept non-matching paths ────

def test_non_team_paths_not_dispatched():
    """Paths like /api/sessions, /api/models must not be intercepted by dispatch."""
    for path in [
        "/api/sessions",
        "/api/models",
        "/api/session?session_id=test",
        "/api/kanban/tasks",
        "/api/gateway/status",
    ]:
        status, body = _get(path)
        assert status != 501, f"GET {path}: should NOT be dispatched to 501, got status {status}"
