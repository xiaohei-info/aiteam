from __future__ import annotations

import importlib
import json
from urllib.parse import urlparse

import pytest

from tests.aiteam.layer0_contracts.test_host_routing import _FakeHandler


@pytest.fixture(autouse=True)
def _reset_auth_router_state():
    import team_panel.api_team.router_auth as router_auth

    importlib.reload(router_auth)
    yield
    importlib.reload(router_auth)


def _handler_json(handler: _FakeHandler) -> dict:
    return json.loads(handler.body.decode("utf-8")) if handler.body else {}


def _request(method: str, parsed_path: str, body: dict | None = None, headers: dict | None = None, client_ip: str = "127.0.0.1") -> _FakeHandler:
    import api.routes as routes

    handler = _FakeHandler()
    handler.client_address = (client_ip, 443)
    if headers:
        handler.headers.update(headers)
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        handler.headers["Content-Length"] = str(len(raw))
        handler.rfile = type("_BytesIO", (), {"read": lambda self, n: raw})()
    parsed = urlparse(f"http://example.com{parsed_path}")
    if method == "GET":
        routes.handle_get(handler, parsed)
    elif method == "POST":
        routes.handle_post(handler, parsed)
    else:
        raise ValueError(method)
    return handler


def _cookies(handler: _FakeHandler) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for key, value in handler.sent_headers:
        if key.lower() != "set-cookie":
            continue
        pair = value.split(";", 1)[0]
        if "=" not in pair:
            continue
        name, cookie_value = pair.split("=", 1)
        cookies[name] = cookie_value
    return cookies


def _cookie_header(cookies: dict[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def _cookie_attrs(handler: _FakeHandler, name: str) -> str:
    prefix = f"{name}="
    for key, value in handler.sent_headers:
        if key.lower() == "set-cookie" and value.startswith(prefix):
            return value
    raise AssertionError(f"missing set-cookie for {name}")


def test_wechat_login_routes_flow_through_api_routes():
    init_handler = _request("POST", "/api/auth/login/wechat/init", headers={"User-Agent": "Chrome QA"}, client_ip="203.0.113.10")
    init_body = _handler_json(init_handler)

    assert init_handler.status == 200
    assert init_body["state"].startswith("wx_")
    assert init_body["qr_url"].startswith("/mock/wechat-qr?state=")
    assert init_body["expires_in"] == 300

    state = init_body["state"]
    assert _handler_json(_request("GET", f"/api/auth/login/wechat/poll?state={state}")).get("status") == "pending"
    assert _handler_json(_request("GET", f"/api/auth/login/wechat/poll?state={state}")).get("status") == "scanned"

    confirmed_handler = _request("GET", f"/api/auth/login/wechat/poll?state={state}")
    confirmed_body = _handler_json(confirmed_handler)
    assert confirmed_handler.status == 200
    assert confirmed_body["status"] == "confirmed"
    assert confirmed_body["code"].startswith("mock_auth_code_")

    callback_handler = _request(
        "POST",
        "/api/auth/login/wechat/callback",
        body={"state": state, "code": confirmed_body["code"]},
        headers={"User-Agent": "Chrome QA"},
        client_ip="203.0.113.10",
    )
    callback_body = _handler_json(callback_handler)
    callback_cookies = _cookies(callback_handler)

    assert callback_handler.status == 200
    assert callback_body["wechat_union_id"] == "mock_union_abc"
    assert callback_body["wechat_open_id"] == "mock_open_abc"
    assert callback_body["access_token"].startswith("at_")
    assert "refresh_token" not in callback_body
    assert callback_body["expires_in"] == 900
    assert {"access_token", "refresh_token"} <= set(callback_cookies)
    refresh_cookie_header = _cookie_attrs(callback_handler, "refresh_token")
    assert "HttpOnly" in refresh_cookie_header
    assert "Secure" in refresh_cookie_header
    assert "SameSite=Lax" in refresh_cookie_header
    assert "Path=/api/auth/refresh" in refresh_cookie_header

    me_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {callback_body['access_token']}"},
    )
    me_body = _handler_json(me_handler)
    assert me_handler.status == 200
    assert me_body["user_id"] == "usr_mock_wechat"
    assert me_body["current_enterprise"] is None
    assert me_body["onboarding"] == {"action": "create_or_join_enterprise"}


def test_phone_verify_refresh_logout_and_replay_flow():
    send_handler = _request("POST", "/api/auth/login/phone/send-code", body={"phone": "13800138000"}, client_ip="198.51.100.20")
    send_body = _handler_json(send_handler)
    assert send_handler.status == 200
    assert send_body == {"expires_in": 300}

    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138000", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.20",
    )
    verify_body = _handler_json(verify_handler)
    verify_cookies = _cookies(verify_handler)

    assert verify_handler.status == 200
    assert verify_body["phone"] == "13800138000"
    assert verify_body["access_token"].startswith("at_")
    assert "refresh_token" not in verify_body
    assert verify_body["expires_in"] == 900
    assert {"access_token", "refresh_token"} <= set(verify_cookies)
    verify_refresh_cookie_header = _cookie_attrs(verify_handler, "refresh_token")
    assert "HttpOnly" in verify_refresh_cookie_header
    assert "Secure" in verify_refresh_cookie_header
    assert "SameSite=Lax" in verify_refresh_cookie_header
    assert "Path=/api/auth/refresh" in verify_refresh_cookie_header

    refresh_handler = _request(
        "POST",
        "/api/auth/refresh",
        headers={"Cookie": f"refresh_token={verify_cookies['refresh_token']}"},
        client_ip="198.51.100.20",
    )
    refresh_body = _handler_json(refresh_handler)
    refresh_cookies = _cookies(refresh_handler)

    assert refresh_handler.status == 200
    assert refresh_body["access_token"].startswith("at_")
    assert refresh_body["expires_in"] == 900
    assert refresh_cookies["refresh_token"].startswith("rt_")
    assert refresh_cookies["refresh_token"] != verify_cookies["refresh_token"]
    refresh_cookie_header = _cookie_attrs(refresh_handler, "refresh_token")
    assert "HttpOnly" in refresh_cookie_header
    assert "Secure" in refresh_cookie_header
    assert "SameSite=Lax" in refresh_cookie_header
    assert "Path=/api/auth/refresh" in refresh_cookie_header

    replay_handler = _request(
        "POST",
        "/api/auth/refresh",
        headers={"Cookie": f"refresh_token={verify_cookies['refresh_token']}"},
        client_ip="198.51.100.20",
    )
    assert replay_handler.status == 401
    assert "replay" in _handler_json(replay_handler)["error"].lower()

    logout_handler = _request(
        "POST",
        "/api/auth/logout",
        body={"all_devices": False},
        headers={"Cookie": _cookie_header({"access_token": refresh_body["access_token"], "refresh_token": refresh_cookies["refresh_token"]})},
        client_ip="198.51.100.20",
    )
    logout_body = _handler_json(logout_handler)
    logout_cookies = _cookies(logout_handler)

    assert logout_handler.status == 200
    assert logout_body == {"ok": True}
    assert logout_cookies["access_token"] in {"", '""'}
    assert logout_cookies["refresh_token"] in {"", '""'}

    me_after_logout = _request("GET", "/api/me", headers={"Authorization": f"Bearer {refresh_body['access_token']}"})
    assert me_after_logout.status == 401


def test_phone_send_code_cooldown_and_wechat_ip_limit():
    first_send = _request("POST", "/api/auth/login/phone/send-code", body={"phone": "13900139000"}, client_ip="198.51.100.33")
    second_send = _request("POST", "/api/auth/login/phone/send-code", body={"phone": "13900139000"}, client_ip="198.51.100.33")

    assert first_send.status == 200
    assert second_send.status == 429
    assert _handler_json(second_send)["cooldown_seconds"] == 60

    last_handler = None
    for _ in range(11):
        last_handler = _request("POST", "/api/auth/login/wechat/init", client_ip="203.0.113.55")
    assert last_handler is not None
    assert last_handler.status == 429
    assert "ip" in _handler_json(last_handler)["error"].lower()


def test_sixth_device_revokes_oldest_refresh_family():
    import team_panel.api_team.router_auth as router_auth

    first_refresh_token = None
    phone = "13700137000"
    for idx in range(6):
        send_handler = _request("POST", "/api/auth/login/phone/send-code", body={"phone": phone}, client_ip=f"198.51.100.{40 + idx}")
        assert send_handler.status == 200
        verify_handler = _request(
            "POST",
            "/api/auth/login/phone/verify",
            body={"phone": phone, "code": "888888"},
            headers={"User-Agent": f"Browser-{idx}"},
            client_ip=f"198.51.100.{40 + idx}",
        )
        assert verify_handler.status == 200
        current_refresh = _cookies(verify_handler)["refresh_token"]
        if idx == 0:
            first_refresh_token = current_refresh
        if idx < 5:
            router_auth._PHONE_STATES[phone]["sent_at"] -= 61
            router_auth._PHONE_STATES[phone]["expires_at"] += 61
            router_auth._SERVICE._rate_limit_events.clear()

    assert first_refresh_token is not None
    evicted_refresh = _request(
        "POST",
        "/api/auth/refresh",
        headers={"Cookie": f"refresh_token={first_refresh_token}"},
        client_ip="198.51.100.99",
    )
    assert evicted_refresh.status == 401
    assert "login again" in _handler_json(evicted_refresh)["error"].lower()


def test_onboarding_create_enterprise_updates_profile_and_current_enterprise():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138100"},
        client_ip="198.51.100.120",
    )
    assert send_handler.status == 200
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138100", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.120",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    create_handler = _request(
        "POST",
        "/api/auth/onboarding/create-enterprise",
        body={"name": "Acme AI Lab", "slug": "acme-ai-lab"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    create_body = _handler_json(create_handler)

    assert create_handler.status == 201
    assert create_body["name"] == "Acme AI Lab"
    assert create_body["slug"] == "acme-ai-lab"
    assert create_body["role"] == "owner"
    assert create_body["enterprise_id"].startswith("ent_")

    me_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_body = _handler_json(me_handler)
    assert me_handler.status == 200
    assert me_body["current_enterprise"]["enterprise_id"] == create_body["enterprise_id"]
    assert me_body["current_enterprise"]["role"] == "owner"
    assert "onboarding" not in me_body

    current_handler = _request(
        "GET",
        "/api/enterprises/current",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    current_body = _handler_json(current_handler)
    assert current_handler.status == 200
    assert current_body["enterprise_id"] == create_body["enterprise_id"]


def test_onboarding_join_enterprise_updates_profile_and_current_enterprise():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138101"},
        client_ip="198.51.100.121",
    )
    assert send_handler.status == 200
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138101", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.121",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    join_body = _handler_json(join_handler)

    assert join_handler.status == 200
    assert join_body["enterprise_id"] == "ent_existing_acme"
    assert join_body["name"] == "Acme AI Lab"
    assert join_body["role"] == "member"

    me_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_body = _handler_json(me_handler)
    assert me_handler.status == 200
    assert me_body["current_enterprise"]["enterprise_id"] == "ent_existing_acme"
    assert me_body["current_enterprise"]["role"] == "member"
    assert "onboarding" not in me_body

    current_handler = _request(
        "GET",
        "/api/enterprises/current",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    current_body = _handler_json(current_handler)
    assert current_handler.status == 200
    assert current_body["enterprise_id"] == "ent_existing_acme"


def test_onboarding_join_enterprise_rejects_invalid_code():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138102"},
        client_ip="198.51.100.122",
    )
    assert send_handler.status == 200
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138102", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.122",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-UNKNOWN"},
        headers={"Authorization": f"Bearer {access_token}"},
    )

    assert join_handler.status == 404
    assert "invite" in _handler_json(join_handler)["error"].lower()


def test_onboarding_join_enterprise_rejects_duplicate_membership():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138103"},
        client_ip="198.51.100.123",
    )
    assert send_handler.status == 200
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138103", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.123",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    first_join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert first_join_handler.status == 200

    second_join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert second_join_handler.status == 409
    assert "already" in _handler_json(second_join_handler)["error"].lower()
