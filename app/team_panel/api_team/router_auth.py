from __future__ import annotations

import hashlib
import http.cookies
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any

from ..application.commands.auth_service import (
    AuthService,
    DeviceRegistrationRequest,
    LogoutRequest,
    PhoneLoginRequest,
    QRLoginRequest,
    RateLimitExceededError,
    RefreshTokenRequest,
)

ACCESS_COOKIE_NAME = "access_token"
REFRESH_COOKIE_NAME = "refresh_token"
ACCESS_TTL_SECONDS = 900
REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
WECHAT_STATE_TTL_SECONDS = 300
PHONE_CODE_TTL_SECONDS = 300
PHONE_COOLDOWN_SECONDS = 60
IP_LOGIN_LIMIT = 10
IP_LOGIN_WINDOW_SECONDS = 60
MAX_ACTIVE_DEVICES = 5
DEFAULT_ENTERPRISE_ID = "ent_001"
DEFAULT_ENTERPRISE_NAME = "Acme AI Lab"
SECONDARY_ENTERPRISE = {"enterprise_id": "ent_002", "name": "Beta Corp", "role": "member"}

_LOCK = threading.RLock()
_SERVICE = AuthService()
_WECHAT_STATES: dict[str, dict[str, Any]] = {}
_PHONE_STATES: dict[str, dict[str, Any]] = {}
_IP_EVENTS: dict[str, list[float]] = {}
_ACCESS_TOKENS: dict[str, dict[str, Any]] = {}
_REFRESH_TOKENS: dict[str, dict[str, Any]] = {}
_FAMILY_INDEX: dict[str, set[str]] = {}
_SESSION_FAMILY: dict[str, str] = {}
_USER_DEVICES: dict[str, list[dict[str, Any]]] = {}


@dataclass
class AuthResult:
    status: int
    body: dict[str, Any]
    headers: list[tuple[str, str]]


class AuthRouteError(ValueError):
    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def handle_wechat_init(*, client_ip: str, user_agent: str) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        _require_ip_capacity(client_ip)
        try:
            result = _SERVICE.init_qr_login(
                QRLoginRequest(
                    enterprise_id=DEFAULT_ENTERPRISE_ID,
                    created_by="mock_wechat_guest",
                )
            )
        except RateLimitExceededError as exc:
            return AuthResult(429, {"error": str(exc)}, [])
        state = _new_state("wx")
        _WECHAT_STATES[state] = {
            "state": state,
            "qr_ref_id": result.qr_ref.id,
            "login_session_id": result.login_session_id,
            "code": f"mock_auth_code_{state}",
            "poll_count": 0,
            "expires_at": time.time() + WECHAT_STATE_TTL_SECONDS,
            "ip": client_ip,
            "user_agent": user_agent,
        }
        return AuthResult(
            200,
            {
                "state": state,
                "qr_url": f"/mock/wechat-qr?state={state}",
                "expires_in": WECHAT_STATE_TTL_SECONDS,
            },
            [],
        )


def handle_wechat_poll(state: str) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        entry = _WECHAT_STATES.get(state)
        if entry is None:
            raise AuthRouteError("Unknown wechat state", status=404)
        if entry["expires_at"] <= time.time():
            return AuthResult(200, {"status": "expired"}, [])
        qr_ref = _SERVICE._qr_refs[entry["qr_ref_id"]]
        poll_count = int(entry.get("poll_count", 0))
        if poll_count == 0:
            entry["poll_count"] = 1
            return AuthResult(200, {"status": "pending"}, [])
        if poll_count == 1:
            if qr_ref.is_pending():
                _SERVICE.confirm_qr_scan(entry["qr_ref_id"], scanned_by_user_id="usr_mock_wechat")
            entry["poll_count"] = 2
            return AuthResult(200, {"status": "scanned"}, [])
        return AuthResult(200, {"status": "confirmed", "code": entry["code"]}, [])


def handle_wechat_callback(state: str, code: str, *, client_ip: str, user_agent: str) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        entry = _WECHAT_STATES.get(state)
        if entry is None:
            raise AuthRouteError("Unknown wechat state", status=404)
        if entry["expires_at"] <= time.time():
            raise AuthRouteError("Wechat login state expired", status=400)
        if code != entry["code"]:
            raise AuthRouteError("Invalid wechat auth code", status=400)
        qr_ref = _SERVICE._qr_refs[entry["qr_ref_id"]]
        if qr_ref.is_pending():
            _SERVICE.confirm_qr_scan(entry["qr_ref_id"], scanned_by_user_id="usr_mock_wechat")
        session = _SERVICE._sessions[entry["login_session_id"]]
        if session.status != "active":
            session = _SERVICE.confirm_qr_login(entry["qr_ref_id"], confirmed_by_user_id="usr_mock_wechat")
        profile = {
            "user_id": session.user_id,
            "nickname": "测试用户",
            "avatar_url": None,
            "is_new_user": True,
            "current_enterprise": None,
            "enterprises": [],
            "onboarding": {"action": "create_or_join_enterprise"},
            "wechat_union_id": "mock_union_abc",
            "wechat_open_id": "mock_open_abc",
        }
        access_token, refresh_token = _issue_session_tokens(
            session_id=session.id,
            enterprise_id=session.enterprise_id,
            user_id=session.user_id,
            refresh_jti=session.refresh_token_jti,
            refresh_expires_at=session.refresh_token_expires_at,
            access_jti=session.access_token_jti,
            access_expires_at=session.expires_at,
            profile=profile,
        )
        _register_device(session_id=session.id, enterprise_id=session.enterprise_id, user_id=session.user_id, client_ip=client_ip, user_agent=user_agent)
        return AuthResult(
            200,
            {
                "wechat_union_id": profile["wechat_union_id"],
                "wechat_open_id": profile["wechat_open_id"],
                "nickname": profile["nickname"],
                "avatar_url": None,
                "is_new_user": True,
                "access_token": access_token,
                "expires_in": ACCESS_TTL_SECONDS,
            },
            _auth_cookie_headers(access_token=access_token, refresh_token=refresh_token),
        )


def handle_phone_send_code(phone: str, *, client_ip: str) -> AuthResult:
    normalized = str(phone or "").strip()
    if not normalized:
        raise AuthRouteError("phone is required", status=400)
    with _LOCK:
        _prune_expired_state()
        _require_ip_capacity(client_ip)
        existing = _PHONE_STATES.get(normalized)
        now = time.time()
        if existing is not None and now - existing.get("sent_at", 0) < PHONE_COOLDOWN_SECONDS:
            return AuthResult(429, {"error": "Phone verification cooldown active", "cooldown_seconds": PHONE_COOLDOWN_SECONDS}, [])
        try:
            result = _SERVICE.init_phone_login(
                PhoneLoginRequest(
                    enterprise_id=DEFAULT_ENTERPRISE_ID,
                    phone_number=normalized,
                    created_by=_user_id_for_phone(normalized),
                )
            )
        except RateLimitExceededError as exc:
            return AuthResult(429, {"error": str(exc)}, [])
        _PHONE_STATES[normalized] = {
            "phone": normalized,
            "phone_ref_id": result.phone_ref.id,
            "login_session_id": result.login_session_id,
            "sent_at": now,
            "expires_at": now + PHONE_CODE_TTL_SECONDS,
            "ip": client_ip,
        }
        return AuthResult(200, {"expires_in": PHONE_CODE_TTL_SECONDS}, [])


def handle_phone_verify(phone: str, code: str, *, client_ip: str, user_agent: str) -> AuthResult:
    normalized = str(phone or "").strip()
    if not normalized:
        raise AuthRouteError("phone is required", status=400)
    with _LOCK:
        _prune_expired_state()
        _require_ip_capacity(client_ip)
        entry = _PHONE_STATES.get(normalized)
        if entry is None:
            raise AuthRouteError("Phone verification not found or expired", status=400)
        if entry["expires_at"] <= time.time():
            raise AuthRouteError("Phone verification not found or expired", status=400)
        try:
            session = _SERVICE.verify_phone_code(entry["phone_ref_id"], code=code)
        except ValueError as exc:
            raise AuthRouteError(str(exc), status=400) from exc
        profile = {
            "user_id": session.user_id,
            "nickname": f"用户{normalized[-4:]}",
            "avatar_url": None,
            "is_new_user": True,
            "current_enterprise": None,
            "enterprises": [],
            "onboarding": {"action": "create_or_join_enterprise"},
            "phone": normalized,
        }
        access_token, refresh_token = _issue_session_tokens(
            session_id=session.id,
            enterprise_id=session.enterprise_id,
            user_id=session.user_id,
            refresh_jti=session.refresh_token_jti,
            refresh_expires_at=session.refresh_token_expires_at,
            access_jti=session.access_token_jti,
            access_expires_at=session.expires_at,
            profile=profile,
        )
        _register_device(session_id=session.id, enterprise_id=session.enterprise_id, user_id=session.user_id, client_ip=client_ip, user_agent=user_agent)
        return AuthResult(
            200,
            {
                "phone": normalized,
                "is_new_user": True,
                "access_token": access_token,
                "expires_in": ACCESS_TTL_SECONDS,
            },
            _auth_cookie_headers(access_token=access_token, refresh_token=refresh_token),
        )


def handle_refresh(refresh_token: str | None, *, client_ip: str, user_agent: str) -> AuthResult:
    del client_ip, user_agent
    with _LOCK:
        _prune_expired_state()
        if not refresh_token:
            raise AuthRouteError("Missing refresh token", status=401)
        record = _REFRESH_TOKENS.get(refresh_token)
        if record is None:
            raise AuthRouteError("Invalid refresh token", status=401)
        family_id = str(record["family_id"])
        if not record.get("valid", False):
            _revoke_family(family_id, reason="refresh_replay_detected")
            raise AuthRouteError("Refresh token replay detected; please login again", status=401)
        session = _SERVICE._sessions[record["session_id"]]
        try:
            refreshed = _SERVICE.refresh_token(
                RefreshTokenRequest(
                    enterprise_id=record["enterprise_id"],
                    user_id=record["user_id"],
                    refresh_token_jti=record["refresh_jti"],
                    login_session_id=record["session_id"],
                )
            )
        except (RateLimitExceededError, ValueError) as exc:
            status = 429 if isinstance(exc, RateLimitExceededError) else 401
            raise AuthRouteError(str(exc), status=status) from exc
        record["valid"] = False
        _ACCESS_TOKENS.pop(record["access_token"], None)
        new_refresh_jti = _SERVICE._new_id("refresh")
        session.refresh_token_jti = new_refresh_jti
        session.refresh_token_expires_at = _SERVICE._future(days=7)
        profile = dict(record["profile"])
        access_token, new_refresh_token = _issue_session_tokens(
            session_id=record["session_id"],
            enterprise_id=record["enterprise_id"],
            user_id=record["user_id"],
            refresh_jti=new_refresh_jti,
            refresh_expires_at=session.refresh_token_expires_at,
            access_jti=refreshed.new_access_jti,
            access_expires_at=refreshed.new_expires_at,
            profile=profile,
            family_id=family_id,
        )
        return AuthResult(
            200,
            {
                "access_token": access_token,
                "expires_in": ACCESS_TTL_SECONDS,
            },
            _auth_cookie_headers(access_token=access_token, refresh_token=new_refresh_token),
        )


def handle_logout(access_token: str | None, refresh_token: str | None, *, all_devices: bool = False) -> AuthResult | None:
    with _LOCK:
        _prune_expired_state()
        family_id = None
        user_id = None
        session_id = None
        if refresh_token and refresh_token in _REFRESH_TOKENS:
            record = _REFRESH_TOKENS[refresh_token]
            family_id = str(record["family_id"])
            user_id = str(record["user_id"])
            session_id = str(record["session_id"])
        elif access_token and access_token in _ACCESS_TOKENS:
            record = _ACCESS_TOKENS[access_token]
            family_id = str(record["family_id"])
            user_id = str(record["user_id"])
            session_id = str(record["session_id"])
        else:
            return None
        if all_devices and user_id is not None:
            for candidate_token, candidate in list(_REFRESH_TOKENS.items()):
                if candidate["user_id"] == user_id:
                    candidate["valid"] = False
                    _ACCESS_TOKENS.pop(candidate["access_token"], None)
        elif family_id is not None:
            _revoke_family(family_id, reason="logout")
        if session_id is not None:
            session = _SERVICE._sessions.get(session_id)
            if session is not None and session.status == "active":
                _SERVICE.logout(
                    LogoutRequest(
                        login_session_id=session_id,
                        enterprise_id=session.enterprise_id,
                        user_id=session.user_id,
                    )
                )
        return AuthResult(200, {"ok": True}, _clear_auth_cookie_headers())


def handle_me(access_token: str | None) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        if not access_token:
            raise AuthRouteError("Unauthorized", status=401)
        record = _ACCESS_TOKENS.get(access_token)
        if record is None or record["expires_at"] <= time.time():
            raise AuthRouteError("Unauthorized", status=401)
        profile = dict(record["profile"])
        body: dict[str, Any] = {
            "user_id": profile["user_id"],
            "nickname": profile["nickname"],
            "avatar_url": profile.get("avatar_url"),
            "current_enterprise": profile.get("current_enterprise"),
            "enterprises": list(profile.get("enterprises", [])),
        }
        if body["current_enterprise"] is None:
            body["onboarding"] = {"action": "create_or_join_enterprise"}
        return AuthResult(200, body, [])


def access_token_from_headers(headers: Any) -> str | None:
    cookie_token = _cookie_value(headers, ACCESS_COOKIE_NAME)
    if cookie_token:
        return cookie_token
    authorization = str(getattr(headers, "get", lambda *_: "")("Authorization", "") or "")
    if authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        return token or None
    return None


def refresh_token_from_headers(headers: Any) -> str | None:
    return _cookie_value(headers, REFRESH_COOKIE_NAME)


def _new_state(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _prune_expired_state() -> None:
    now = time.time()
    for key, entry in list(_WECHAT_STATES.items()):
        if entry.get("expires_at", 0) <= now:
            _WECHAT_STATES.pop(key, None)
    for phone, entry in list(_PHONE_STATES.items()):
        if entry.get("expires_at", 0) <= now:
            _PHONE_STATES.pop(phone, None)
    for key, timestamps in list(_IP_EVENTS.items()):
        fresh = [ts for ts in timestamps if now - ts < IP_LOGIN_WINDOW_SECONDS]
        if fresh:
            _IP_EVENTS[key] = fresh
        else:
            _IP_EVENTS.pop(key, None)
    for token, record in list(_ACCESS_TOKENS.items()):
        if record.get("expires_at", 0) <= now:
            _ACCESS_TOKENS.pop(token, None)
    for token, record in list(_REFRESH_TOKENS.items()):
        if record.get("expires_at", 0) <= now:
            _REFRESH_TOKENS.pop(token, None)
            family_id = str(record["family_id"])
            members = _FAMILY_INDEX.get(family_id)
            if members is not None:
                members.discard(token)
                if not members:
                    _FAMILY_INDEX.pop(family_id, None)


def _require_ip_capacity(client_ip: str) -> None:
    now = time.time()
    events = [ts for ts in _IP_EVENTS.get(client_ip, []) if now - ts < IP_LOGIN_WINDOW_SECONDS]
    if len(events) >= IP_LOGIN_LIMIT:
        raise AuthRouteError("Too many login attempts from this IP", status=429)
    events.append(now)
    _IP_EVENTS[client_ip] = events


def _issue_session_tokens(
    *,
    session_id: str,
    enterprise_id: str,
    user_id: str,
    refresh_jti: str | None,
    refresh_expires_at: str | None,
    access_jti: str | None,
    access_expires_at: str | None,
    profile: dict[str, Any],
    family_id: str | None = None,
) -> tuple[str, str]:
    if refresh_jti is None or access_jti is None or refresh_expires_at is None or access_expires_at is None:
        raise AuthRouteError("Active session is missing token metadata", status=500)
    resolved_family_id = family_id or _SESSION_FAMILY.get(session_id) or _new_state("fam")
    access_token = f"at_{access_jti}"
    refresh_token = f"rt_{refresh_jti}"
    _SESSION_FAMILY[session_id] = resolved_family_id
    _ACCESS_TOKENS[access_token] = {
        "session_id": session_id,
        "enterprise_id": enterprise_id,
        "user_id": user_id,
        "family_id": resolved_family_id,
        "expires_at": _iso_to_epoch(access_expires_at),
        "profile": dict(profile),
    }
    _REFRESH_TOKENS[refresh_token] = {
        "session_id": session_id,
        "enterprise_id": enterprise_id,
        "user_id": user_id,
        "family_id": resolved_family_id,
        "refresh_jti": refresh_jti,
        "expires_at": _iso_to_epoch(refresh_expires_at),
        "valid": True,
        "profile": dict(profile),
        "access_token": access_token,
    }
    _FAMILY_INDEX.setdefault(resolved_family_id, set()).add(refresh_token)
    return access_token, refresh_token


def _register_device(*, session_id: str, enterprise_id: str, user_id: str, client_ip: str, user_agent: str) -> None:
    fingerprint = hashlib.sha256(f"{client_ip}|{user_agent}".encode("utf-8")).hexdigest()[:16]
    _SERVICE.register_device(
        DeviceRegistrationRequest(
            login_session_id=session_id,
            enterprise_id=enterprise_id,
            user_id=user_id,
            device_fingerprint=fingerprint,
            device_name=_device_name(user_agent),
            ip_address=client_ip,
            user_agent=user_agent,
        )
    )
    devices = [device for device in _USER_DEVICES.get(user_id, []) if device.get("fingerprint") != fingerprint]
    devices.append({
        "fingerprint": fingerprint,
        "session_id": session_id,
        "last_seen_at": time.time(),
    })
    devices.sort(key=lambda item: item["last_seen_at"])
    while len(devices) > MAX_ACTIVE_DEVICES:
        evicted = devices.pop(0)
        family_id = _SESSION_FAMILY.get(str(evicted["session_id"]))
        if family_id:
            _revoke_family(family_id, reason="device_limit_exceeded")
    _USER_DEVICES[user_id] = devices


def _revoke_family(family_id: str, *, reason: str) -> None:
    for refresh_token in list(_FAMILY_INDEX.get(family_id, set())):
        record = _REFRESH_TOKENS.get(refresh_token)
        if record is None:
            continue
        record["valid"] = False
        _ACCESS_TOKENS.pop(record.get("access_token"), None)
        session = _SERVICE._sessions.get(record["session_id"])
        if session is not None and session.status == "active":
            session.revoke(reason=reason, revoked_at=_SERVICE._now())


def _auth_cookie_headers(*, access_token: str, refresh_token: str) -> list[tuple[str, str]]:
    return [
        ("Set-Cookie", _build_cookie(ACCESS_COOKIE_NAME, access_token, max_age=ACCESS_TTL_SECONDS, path="/")),
        ("Set-Cookie", _build_cookie(REFRESH_COOKIE_NAME, refresh_token, max_age=REFRESH_TTL_SECONDS, path="/api/auth/refresh")),
        ("Cache-Control", "no-store"),
    ]


def _clear_auth_cookie_headers() -> list[tuple[str, str]]:
    return [
        ("Set-Cookie", _build_cookie(ACCESS_COOKIE_NAME, "", max_age=0, path="/")),
        ("Set-Cookie", _build_cookie(REFRESH_COOKIE_NAME, "", max_age=0, path="/api/auth/refresh")),
        ("Cache-Control", "no-store"),
    ]


def _build_cookie(name: str, value: str, *, max_age: int, path: str) -> str:
    cookie = http.cookies.SimpleCookie()
    cookie[name] = value
    cookie[name]["path"] = path
    cookie[name]["max-age"] = str(max_age)
    cookie[name]["httponly"] = True
    cookie[name]["secure"] = True
    cookie[name]["samesite"] = "Lax"
    return cookie.output(header="").strip()


def _cookie_value(headers: Any, name: str) -> str | None:
    raw = str(getattr(headers, "get", lambda *_: "")("Cookie", "") or "")
    if not raw:
        return None
    cookie = http.cookies.SimpleCookie()
    cookie.load(raw)
    morsel = cookie.get(name)
    if morsel is None:
        return None
    value = morsel.value.strip()
    return value or None


def _device_name(user_agent: str) -> str:
    text = (user_agent or "Mock Browser").strip()
    if not text:
        return "Mock Browser"
    return text[:80]


def _user_id_for_phone(phone: str) -> str:
    return f"usr_{hashlib.sha256(phone.encode('utf-8')).hexdigest()[:8]}"


def _iso_to_epoch(value: str) -> float:
    return time.mktime(time.strptime(value.replace("+00:00", "Z"), "%Y-%m-%dT%H:%M:%S.%fZ" if "." in value else "%Y-%m-%dT%H:%M:%SZ")) if value.endswith("Z") else time.time() + ACCESS_TTL_SECONDS
