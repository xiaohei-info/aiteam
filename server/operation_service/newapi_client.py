"""Bounded server-side client for the internal NewAPI management plane."""
from __future__ import annotations

import json as jsonlib
import time
from typing import Any
from urllib.parse import quote

import httpx


class NewApiError(RuntimeError):
    pass


class NewApiAdminClient:
    _MAX_RESPONSE = 2 * 1024 * 1024

    def __init__(self, base_url: str, admin_token: str, admin_user_id: str, timeout: float = 10.0, transport=None):
        self._base_url = base_url.rstrip("/")
        self._admin_token = admin_token
        self._admin_user_id = admin_user_id
        self._client = httpx.Client(base_url=self._base_url, timeout=timeout, transport=transport)

    def close(self) -> None:
        self._client.close()

    def _request(self, method: str, path: str, *, json: dict | None = None, token: str | None = None, user_id: str | int | None = None, auth: bool = True) -> dict:
        headers = {"Accept": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {token or self._admin_token}"
            headers["New-Api-User"] = str(user_id or self._admin_user_id)
        with self._client.stream(method, path, json=json, headers=headers) as response:
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > self._MAX_RESPONSE:
                    raise NewApiError("NewAPI response exceeded 2 MiB")
        if response.status_code < 200 or response.status_code >= 300:
            raise NewApiError(f"NewAPI request failed with HTTP {response.status_code}")
        try:
            payload = jsonlib.loads(body)
        except ValueError as exc:
            raise NewApiError("NewAPI returned invalid JSON") from exc
        if not isinstance(payload, dict) or payload.get("success") is not True:
            detail = str(payload.get("message") or "NewAPI operation failed")[:200] if isinstance(payload, dict) else "NewAPI operation failed"
            raise NewApiError(detail)
        return payload

    def fetch_available_models(self) -> list[str]:
        """Read the model catalog exposed by the internal NewAPI gateway."""
        payload = self._request("GET", "/api/models")
        raw = payload.get("data")
        if not isinstance(raw, dict):
            raise NewApiError("NewAPI returned an invalid model catalog")
        models: set[str] = set()
        for channel_models in raw.values():
            if not isinstance(channel_models, list) or any(not isinstance(item, str) for item in channel_models):
                raise NewApiError("NewAPI returned an invalid model catalog")
            models.update(item.strip() for item in channel_models if item.strip())
        return sorted(models)

    def fetch_channel_models(self, channel_id: int) -> list[str]:
        """Compatibility helper for diagnostics of a specific NewAPI channel."""
        payload = self._request("GET", f"/api/channel/fetch_models/{channel_id}")
        raw = payload.get("data") or []
        if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
            raise NewApiError("NewAPI returned an invalid model list")
        return sorted(set(item.strip() for item in raw if item.strip()))

    def pricing(self) -> dict:
        return self._request("GET", "/api/pricing", auth=False)

    def find_user(self, username: str) -> dict | None:
        payload = self._request("GET", f"/api/user/search?keyword={quote(username)}&p=1&page_size=20")
        items = (payload.get("data") or {}).get("items") or []
        return next((item for item in items if item.get("username") == username), None)

    def create_user(self, *, username: str, password: str, display_name: str) -> int:
        self._request("POST", "/api/user/", json={"username": username, "password": password, "display_name": display_name, "role": 1, "status": 1})
        user = self.find_user(username)
        if not user:
            raise NewApiError("NewAPI user creation was not observable")
        return int(user["id"])

    def add_user_quota(self, user_id: int, quota: int) -> None:
        self._request("POST", "/api/user/manage", json={"id": user_id, "action": "add_quota", "value": quota, "mode": "add"})

    def login(self, username: str, password: str) -> tuple[str, int]:
        payload = self._request("POST", "/api/user/login", json={"username": username, "password": password}, auth=False)
        data = payload.get("data") or {}
        user = data.get("user") or {}
        token = data.get("access_token")
        if not isinstance(token, str) or not token or not user.get("id"):
            raise NewApiError("NewAPI login returned an invalid session")
        return token, int(user["id"])

    def generate_management_token(self, dashboard_token: str, user_id: int) -> str:
        payload = self._request("GET", "/api/user/token", token=dashboard_token, user_id=user_id)
        token = payload.get("data")
        if not isinstance(token, str) or not token:
            raise NewApiError("NewAPI returned an invalid management token")
        return token

    def _list_user_tokens(self, *, dashboard_token: str, user_id: int) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/token/?p=1&size=100", token=dashboard_token, user_id=user_id)
        items = (payload.get("data") or {}).get("items") or []
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise NewApiError("NewAPI returned an invalid token list")
        return items

    @staticmethod
    def _matching_token(items: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
        matches = [item for item in items if item.get("name") == name]
        if len(matches) > 1:
            ids = sorted(str(item.get("id")) for item in matches)
            raise NewApiError(f"NewAPI relay token name is ambiguous: {name} ({', '.join(ids)})")
        return matches[0] if matches else None

    def _resolve_created_token(self, *, dashboard_token: str, user_id: int, name: str) -> dict[str, Any]:
        # NewAPI persists token creation asynchronously. Poll only after the POST;
        # never retry the POST, because a retry could create an untracked duplicate.
        for attempt in range(5):
            match = self._matching_token(self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id), name)
            if match is not None:
                return match
            if attempt < 4:
                time.sleep(0.2 * (attempt + 1))
        raise NewApiError(f"NewAPI created relay token was not observable: {name}")

    def create_relay_token(self, *, dashboard_token: str, user_id: int, name: str, model_ids: list[str], remain_quota: int, expired_time: int = -1) -> tuple[int, str]:
        # Resolve an existing deterministic name first. This makes retries after a
        # successful POST idempotent and prevents another duplicate token.
        existing = self._matching_token(self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id), name)
        if existing is None:
            self._request("POST", "/api/token/", token=dashboard_token, user_id=user_id, json={
                "name": name,
                "expired_time": expired_time,
                "remain_quota": remain_quota,
                "unlimited_quota": False,
                "model_limits_enabled": True,
                "model_limits": ",".join(model_ids),
                "allow_ips": "",
                "group": "default",
                "cross_group_retry": False,
            })
            existing = self._resolve_created_token(dashboard_token=dashboard_token, user_id=user_id, name=name)
        token_id_raw = existing.get("id")
        try:
            token_id = int(token_id_raw)
        except (TypeError, ValueError) as exc:
            raise NewApiError("NewAPI returned an invalid relay token id") from exc
        revealed = self._request("POST", f"/api/token/{token_id}/key", token=dashboard_token, user_id=user_id).get("data")
        key = revealed.get("key") if isinstance(revealed, dict) else revealed
        if not isinstance(key, str) or not key:
            raise NewApiError("NewAPI returned an invalid relay token")
        return token_id, key if key.startswith("sk-") else f"sk-{key}"
