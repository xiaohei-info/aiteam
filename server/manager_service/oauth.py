"""OAuth 第三方登录（issue AITEAM-253，「OAuth 第三方登录（Google/GitHub 等）」缺口）。

口径（03 §9.3「多一个 provider 取值 + 一个 Authenticator；user/token 零改」）：
- OAuth 是 manager 成员账户的一个新 Authenticator/provider=oauth。
- 校验由 `OAuthProvider` 实现方（Google/GitHub/…）负责：换 access_token + 取身份声明 -> 反查/建 auth_identity(user)。
- Manager 不持三方长期 token（红线：不存跨端可逆凭据）；登录即签发自有 JWT。
- 登录态/CSRF 以含租户+nonce 的 state 经易失内存落地（TTL），回调校验后清除。

依赖：httpx（已列为 server 依赖）做对上游 token / userinfo 的交换。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


class OAuthError(ValueError):
    """OAuth 流程校验失败（含上游拒绝 / 身份不匹配）。"""


@dataclass(frozen=True)
class OAuthProfile:
    provider: str
    provider_user_id: str
    email: str | None = None

    @property
    def external_id(self) -> str:
        return "%s:%s" % (self.provider, self.provider_user_id)


class OAuthConnectionRow:
    __slots__ = ("id", "tenant_id", "user_id", "provider", "provider_user_id",
                 "profile_email", "connected_at", "last_login_at")

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class OAuthProvider(ABC):
    """单个 OAuth 提供方的协议适配。实现方只做网络交换 + 解析，不做用户映射。"""

    name: str = ""

    @abstractmethod
    def authorization_url(self, state: str, redirect_uri: str, *, nonce: str, scope: str | None = None) -> str:
        """构建授权跳转 URL（浏览器导航用）。"""
        ...

    @abstractmethod
    def exchange(self, code: str, redirect_uri: str) -> dict[str, Any]:
        """授权码 -> token response（dict）。"""
        ...

    @abstractmethod
    def fetch_profile(self, token_response: dict[str, Any]) -> OAuthProfile:
        """从 token response 提取标准化的 provider_user_id/email。"""
        ...


class GoogleOAuth(OAuthProvider):
    name = "google"
    _auth = "https://accounts.google.com/o/oauth2/v2/auth"
    _token = "https://oauth2.googleapis.com/token"
    _userinfo = "https://openidconnect.googleapis.com/v1/userinfo"

    def __init__(self, *, client_id: str, client_secret: str, scopes: str | None = None):
        self._client_id = client_id
        self._client_secret = client_secret
        self._scopes = scopes or "openid email profile"

    def authorization_url(self, state, redirect_uri, *, nonce=None, scope=None):
        from urllib.parse import urlencode
        params = {
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope or self._scopes,
            "state": state,
            "nonce": nonce or "",
            "access_type": "online",
            "prompt": "select_account",
        }
        return self._auth + "?" + urlencode(params)

    def exchange(self, code, redirect_uri):
        return _http_form_post(self._token, {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        })

    def fetch_profile(self, token_response):
        access = token_response.get("access_token")
        if not access:
            raise OAuthError("google token exchange missing access_token")
        headers = {"Authorization": "Bearer " + access}
        resp = httpx.get(self._userinfo, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        sub = data.get("sub")
        if not sub:
            raise OAuthError("google userinfo missing sub")
        return OAuthProfile(provider="google", provider_user_id=str(sub), email=data.get("email"))


class GitHubOAuth(OAuthProvider):
    name = "github"
    _auth = "https://github.com/login/oauth/authorize"
    _token = "https://github.com/login/oauth/access_token"
    _userapi = "https://api.github.com/user"
    _emails = "https://api.github.com/user/emails"

    def __init__(self, *, client_id: str, client_secret: str):
        self._client_id = client_id
        self._client_secret = client_secret

    def authorization_url(self, state, redirect_uri, *, nonce=None, scope=None):
        from urllib.parse import urlencode
        params = {
            "client_id": self._client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "scope": "read:user user:email",
            "allow_signup": "false",
        }
        return self._auth + "?" + urlencode(params)

    def exchange(self, code, redirect_uri):
        return _http_form_post(self._token, {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }, accept="application/json")

    def fetch_profile(self, token_response):
        access = token_response.get("access_token")
        if not access:
            raise OAuthError("github token exchange missing access_token")
        headers = {"Authorization": "token " + access, "Accept": "application/vnd.github+json"}
        resp = httpx.get(self._userapi, headers=headers, timeout=15)
        resp.raise_for_status()
        user = resp.json()
        provider_id = user.get("id")
        if provider_id is None:
            raise OAuthError("github /user missing id")
        email = user.get("email")
        if not email:
            email = self._primary_email(headers)
        return OAuthProfile(provider="github", provider_user_id=str(provider_id), email=email)

    def _primary_email(self, headers):
        try:
            resp = httpx.get(self._emails, headers=headers, timeout=15)
            resp.raise_for_status()
            for e in resp.json() or []:
                if e.get("primary") and e.get("verified"):
                    return e.get("email")
        except Exception:  # noqa: BLE001
            return None
        return None


def _http_form_post(url, data, *, accept="application/json"):
    resp = httpx.post(url, data=data, headers={"Accept": accept}, timeout=15)
    resp.raise_for_status()
    return resp.json() if "json" in resp.headers.get("content-type", "") else dict(resp.json()) if resp.text else {}


# ---- 登录态（state）落地：易失内存 TTL（不落库，不持久化）----
_state_store: dict[str, dict[str, Any]] = {}
_state_lock = threading.Lock()
_STATE_TTL = 600


def _make_state(tenant_id: str, redirect_uri: str) -> str:
    nonce = secrets.token_urlsafe(24)
    payload = {"t": tenant_id, "r": redirect_uri, "n": nonce, "ts": time.time()}
    raw = json.dumps(payload, sort_keys=True).encode("utf-8")
    sig = hmac.new(_state_pepper(), raw, hashlib.sha256).hexdigest()[:24]
    token = _b64u(raw) + "." + sig
    with _state_lock:
        _cleanup_state(time.time())
        _state_store[token] = {**payload, "_sig": sig}
    return token


def _consume_state(state: str) -> dict[str, Any]:
    try:
        raw_b64, sig = state.split(".", 1)
    except ValueError:
        raise OAuthError("malformed state")
    raw = _b64u_decode(raw_b64)
    expected = hmac.new(_state_pepper(), raw, hashlib.sha256).hexdigest()[:24]
    if not hmac.compare_digest(sig, expected):
        raise OAuthError("state signature mismatch")
    with _state_lock:
        entry = _state_store.pop(state, None)
        _cleanup_state(time.time())
    if entry is None:
        raise OAuthError("state expired or already used")
    payload = json.loads(raw.decode("utf-8"))
    if payload.get("t") != entry.get("t") or payload.get("r") != entry.get("r"):
        raise OAuthError("state tampered")
    return payload


def _cleanup_state(now: float) -> None:
    expired = [k for k, v in _state_store.items() if now - v.get("ts", 0) > _STATE_TTL]
    for k in expired:
        _state_store.pop(k, None)


def _state_pepper() -> bytes:
    return os.getenv("OAUTH_STATE_PEPPER", "manager-oauth-state").encode("utf-8")


def _b64u(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(value) -> bytes:
    import base64
    if isinstance(value, str):
        value = value.encode("ascii")
    value = bytes(value)
    value += b"=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value)


# ---- 连接持久化（oauth_connection 表）----
class OAuthConnectionStore:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def find(self, ctx: TenantContext, *, external_id: str) -> OAuthConnectionRow | None:
        with self._router.session(ctx) as s:
            r = s.execute(
                "SELECT id, tenant_id, user_id, provider, provider_user_id, profile_email, connected_at, last_login_at "
                "FROM oauth_connection WHERE tenant_id = %s AND provider_user_id = %s LIMIT 1",
                (ctx.tenant_id, _suffix(external_id)),
            ).fetchone()
        if not r:
            return None
        return OAuthConnectionRow(
            id=str(r[0]), tenant_id=str(r[1]), user_id=str(r[2]), provider=r[3],
            provider_user_id=r[4], profile_email=r[5], connected_at=r[6], last_login_at=r[7],
        )

    def upsert(self, ctx: TenantContext, *, profile: OAuthProfile, user_id: str) -> str:
        with self._router.session(ctx) as s:
            r = s.execute(
                "INSERT INTO oauth_connection "
                "  (tenant_id, user_id, provider, provider_user_id, profile_email, last_login_at) "
                "VALUES (%s, %s, %s, %s, %s, now()) "
                "ON CONFLICT (tenant_id, provider, provider_user_id) DO UPDATE "
                "  SET user_id = EXCLUDED.user_id, profile_email = EXCLUDED.profile_email, last_login_at = now() "
                "RETURNING id",
                (ctx.tenant_id, user_id, profile.provider, profile.provider_user_id, profile.email),
            ).fetchone()
        return str(r[0])

    def list_for_user(self, ctx: TenantContext, user_id: str) -> list[OAuthConnectionRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, tenant_id, user_id, provider, provider_user_id, profile_email, connected_at, last_login_at "
                "FROM oauth_connection WHERE user_id = %s ORDER BY connected_at",
                (user_id,),
            ).fetchall()
        return [
            OAuthConnectionRow(id=str(r[0]), tenant_id=str(r[1]), user_id=str(r[2]),
                                provider=r[3], provider_user_id=r[4], profile_email=r[5],
                                connected_at=r[6], last_login_at=r[7]) for r in rows
        ]

    def delete(self, ctx: TenantContext, *, provider: str, user_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute(
                "DELETE FROM oauth_connection WHERE provider = %s AND user_id = %s",
                (provider, user_id),
            )
            return cur.rowcount > 0


def _suffix(external_id: str) -> str:
    # external_id 形如 google:<sub>；连接表只按 provider_user_id 存 sub。
    if ":" in external_id:
        return external_id.split(":", 1)[1]
    return external_id
