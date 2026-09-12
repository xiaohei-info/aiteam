"""Bounded server-side client for the internal NewAPI management plane."""
from __future__ import annotations

import json as jsonlib
import re
import time
from typing import Any
from urllib.parse import quote

import httpx


class NewApiError(RuntimeError):
    def __init__(self, message: str, *, token_id: int | None = None):
        super().__init__(message)
        # Used only by the Operator recovery boundary to fence a token that was
        # created upstream before a later detail/key read became uncertain.
        self.token_id = token_id


def _redact_error_detail(value: str) -> str:
    """Keep upstream diagnostics bounded without echoing credential material."""
    text = value.replace("\n", " ")
    text = re.sub(r"(?i)bearer\s+[^\s,;]+", "Bearer [redacted]", text)
    text = re.sub(r"(?i)sk-[A-Za-z0-9._~+/=-]+", "[redacted]", text)
    text = re.sub(r"(?i)(token|key|password|secret)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", text)
    return text[:200] or "NewAPI operation failed"


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
        try:
            with self._client.stream(method, path, json=json, headers=headers) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > self._MAX_RESPONSE:
                        raise NewApiError("NewAPI response exceeded 2 MiB")
        except NewApiError:
            raise
        except httpx.HTTPError as exc:
            # A transport failure leaves a write outcome unknown.  Callers
            # must reconcile by stable token id/name before retrying; never
            # blindly repeat token creation.
            raise NewApiError("NewAPI request outcome is unknown") from exc
        if response.status_code < 200 or response.status_code >= 300:
            raise NewApiError(f"NewAPI request failed with HTTP {response.status_code}")
        try:
            payload = jsonlib.loads(body)
        except ValueError as exc:
            raise NewApiError("NewAPI returned invalid JSON") from exc
        if not isinstance(payload, dict) or payload.get("success") is not True:
            detail = str(payload.get("message") or "NewAPI operation failed") if isinstance(payload, dict) else "NewAPI operation failed"
            raise NewApiError(_redact_error_detail(detail))
        return payload

    def get_channel_models(self, channel_id: int) -> list[str]:
        payload = self._request("GET", f"/api/channel/{channel_id}")
        data = payload.get("data")
        raw = data.get("models") if isinstance(data, dict) else None
        if not isinstance(raw, str):
            raise NewApiError("LLM gateway returned an invalid configured model list")
        return sorted(set(item.strip() for item in raw.split(",") if item.strip()))

    def fetch_channel_models(self, channel_id: int) -> list[str]:
        """Compatibility alias for callers that used the old discovery name."""
        return self.get_channel_models(channel_id)

    def pricing(self) -> dict:
        return self._request("GET", "/api/pricing", auth=False)

    def find_user(self, username: str) -> dict | None:
        """Reconcile an exact username across the bounded search result."""
        page_size = 20
        seen = 0
        for page in range(1, 101):
            payload = self._request(
                "GET",
                f"/api/user/search?keyword={quote(username)}&p={page}&page_size={page_size}",
            )
            data = payload.get("data") or {}
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
                raise NewApiError("NewAPI returned an invalid user search")
            match = next((item for item in items if item.get("username") == username), None)
            if match is not None:
                return match
            seen += len(items)
            total = data.get("total") if isinstance(data, dict) else None
            try:
                total_count = int(str(total)) if total is not None else None
            except (TypeError, ValueError) as exc:
                raise NewApiError("NewAPI returned an invalid user search total") from exc
            if not items or len(items) < page_size or (total_count is not None and seen >= total_count):
                return None
        raise NewApiError("NewAPI user search pagination exceeded the bounded limit")

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

    def get_user_quota(self, *, dashboard_token: str, user_id: int) -> int:
        """Read the authenticated tenant user's quota for bootstrap recovery."""
        data = self._request(
            "GET", "/api/user/self", token=dashboard_token, user_id=user_id,
        ).get("data")
        raw_quota = data.get("quota") if isinstance(data, dict) else None
        try:
            quota = int(str(raw_quota))
        except (TypeError, ValueError) as exc:
            raise NewApiError("NewAPI returned an invalid tenant quota") from exc
        if quota < 0:
            raise NewApiError("NewAPI returned an invalid tenant quota")
        return quota

    def generate_management_token(self, dashboard_token: str, user_id: int) -> str:
        payload = self._request("GET", "/api/user/token", token=dashboard_token, user_id=user_id)
        token = payload.get("data")
        if not isinstance(token, str) or not token:
            raise NewApiError("NewAPI returned an invalid management token")
        return token

    def _list_user_tokens(self, *, dashboard_token: str, user_id: int) -> list[dict[str, Any]]:
        """Read all visible token pages before declaring an id absent.

        NewAPI's token list is paginated.  A first-page miss is not evidence
        that a recorded token was deleted, especially after a tenant has
        rotated more than one hundred credentials.
        """
        page_size = 100
        items: list[dict[str, Any]] = []
        page = 1
        for _ in range(100):
            payload = self._request(
                "GET",
                f"/api/token/?p={page}&size={page_size}",
                token=dashboard_token,
                user_id=user_id,
            )
            data = payload.get("data") or {}
            page_items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(page_items, list) or any(not isinstance(item, dict) for item in page_items):
                raise NewApiError("NewAPI returned an invalid token list")
            items.extend(page_items)
            total = data.get("total") if isinstance(data, dict) else None
            try:
                total_count = int(str(total)) if total is not None else None
            except (TypeError, ValueError) as exc:
                raise NewApiError("NewAPI returned an invalid token list total") from exc
            if not page_items or len(page_items) < page_size or (total_count is not None and len(items) >= total_count):
                return items
            page += 1
        raise NewApiError("NewAPI token pagination exceeded the bounded limit")

    def list_relay_tokens(self, *, dashboard_token: str, user_id: int) -> list[dict[str, Any]]:
        """Return the bounded, masked token metadata visible to one tenant user."""
        return self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id)

    @staticmethod
    def _token_id(item: dict[str, Any]) -> int | None:
        try:
            value = int(str(item.get("id")))
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None

    def get_relay_token(self, *, dashboard_token: str, user_id: int, token_id: int) -> dict[str, Any] | None:
        """Reconcile one token by id before repeating an uncertain write."""
        for item in self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id):
            if self._token_id(item) == token_id:
                return item
        return None

    def find_relay_token_by_name(self, *, dashboard_token: str, user_id: int, name: str) -> dict[str, Any] | None:
        """Resolve a deterministic create receipt only after full pagination."""
        return self._matching_token(
            self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id), name,
        )

    def reconcile_relay_token(
        self,
        *,
        dashboard_token: str,
        user_id: int,
        name: str,
        model_ids: list[str],
        expired_time: int,
    ) -> tuple[int, str] | None:
        """Reconcile a prior create attempt without issuing another POST."""
        match = self.find_relay_token_by_name(
            dashboard_token=dashboard_token, user_id=user_id, name=name,
        )
        if match is None:
            return None
        metadata = match
        token_id = self._token_id(match)
        if token_id is None:
            raise NewApiError("NewAPI returned an invalid relay token id")
        if not self._has_complete_token_metadata(metadata):
            try:
                metadata = self.get_relay_token_detail(
                    dashboard_token=dashboard_token, user_id=user_id, token_id=token_id,
                )
            except NewApiError as exc:
                raise NewApiError(str(exc), token_id=token_id) from exc
        try:
            self._validate_token_metadata(
                metadata, model_ids=model_ids, expired_time=expired_time,
            )
        except NewApiError as exc:
            token_id = self._token_id(match)
            if token_id is not None:
                raise NewApiError(str(exc), token_id=token_id) from exc
            raise
        token_id = self._token_id(metadata)
        if token_id is None:
            raise NewApiError("NewAPI returned an invalid relay token id")
        try:
            key = self.get_relay_token_key(
                dashboard_token=dashboard_token,
                user_id=user_id,
                token_id=token_id,
                model_ids=model_ids,
                expired_time=expired_time,
            )
        except NewApiError as exc:
            raise NewApiError(str(exc), token_id=token_id) from exc
        return token_id, key

    # Compatibility aliases for lifecycle workers.
    find_relay_token = get_relay_token

    def get_relay_token_detail(self, *, dashboard_token: str, user_id: int, token_id: int) -> dict[str, Any]:
        """Read one token detail and bind it to the requested recorded ID."""
        detail = self._request(
            "GET", f"/api/token/{token_id}", token=dashboard_token, user_id=user_id,
        ).get("data")
        if not isinstance(detail, dict) or self._token_id(detail) != token_id:
            raise NewApiError("NewAPI returned a mismatched relay token id")
        return detail

    def get_relay_token_key(
        self,
        *,
        dashboard_token: str,
        user_id: int,
        token_id: int,
        model_ids: list[str] | None = None,
        expired_time: int | None = None,
    ) -> str:
        """Read a full key only from the verified token-detail response."""
        detail = self.get_relay_token_detail(
            dashboard_token=dashboard_token, user_id=user_id, token_id=token_id,
        )
        if model_ids is not None and expired_time is not None:
            self._validate_token_metadata(
                detail, model_ids=model_ids, expired_time=expired_time,
            )
        key = detail.get("key")
        if not isinstance(key, str) or not key or "*" in key:
            raise NewApiError("NewAPI did not return a full relay token key")
        return key if key.startswith("sk-") else f"sk-{key}"

    @staticmethod
    def _model_limits(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, (list, tuple, set)):
            return ",".join(str(item) for item in value if str(item))
        if isinstance(value, dict):
            return ",".join(str(item) for item, enabled in value.items() if enabled)
        return ""

    def _token_update_payload(
        self,
        existing: dict[str, Any],
        *,
        token_id: int,
        model_ids: list[str] | None,
        expired_time: int | None,
        remain_quota: int | None,
        status: int | None,
    ) -> dict[str, Any]:
        """Build the full non-secret model.Token body required by UpdateToken."""
        payload = {
            "id": token_id,
            "name": str(existing.get("name") or f"aiteam-token-{token_id}")[:50],
            "status": int(existing.get("status") or 1) if status is None else status,
            # Preserve quota/limits unless the caller explicitly changes them.
            # In particular, renewal must not reset the upstream used balance.
            "expired_time": int(existing.get("expired_time", -1)) if expired_time is None else expired_time,
            "remain_quota": int(existing.get("remain_quota") or 0) if remain_quota is None else remain_quota,
            "unlimited_quota": bool(existing.get("unlimited_quota", False)),
            "model_limits_enabled": True if model_ids is not None else bool(existing.get("model_limits_enabled", True)),
            "model_limits": ",".join(model_ids) if model_ids is not None else self._model_limits(existing.get("model_limits")),
            "allow_ips": existing.get("allow_ips") or "",
            "group": str(existing.get("group") or "default"),
            "cross_group_retry": bool(existing.get("cross_group_retry", False)),
        }
        return payload

    def update_relay_token(
        self,
        *,
        dashboard_token: str,
        user_id: int,
        token_id: int,
        model_ids: list[str] | None = None,
        expired_time: int | None = None,
        remain_quota: int | None = None,
        status: int | None = None,
    ) -> dict:
        """Update a token through rc.25's proven PUT /api/token/ contract."""
        existing = self.get_relay_token(dashboard_token=dashboard_token, user_id=user_id, token_id=token_id)
        if existing is None:
            raise NewApiError(f"NewAPI relay token not found: {token_id}")
        required = {"name", "status", "expired_time", "remain_quota", "unlimited_quota", "model_limits_enabled", "model_limits", "allow_ips", "group", "cross_group_retry"}
        if not all(name in existing and existing[name] is not None for name in required):
            existing = self.get_relay_token_detail(
                dashboard_token=dashboard_token, user_id=user_id, token_id=token_id,
            )
        payload = self._token_update_payload(
            existing,
            token_id=token_id,
            model_ids=model_ids,
            expired_time=expired_time,
            remain_quota=remain_quota,
            status=status,
        )
        return self._request("PUT", "/api/token/", token=dashboard_token, user_id=user_id, json=payload)

    # Compatibility spelling used by lifecycle workers.
    update_token = update_relay_token

    def revoke_relay_token(self, *, dashboard_token: str, user_id: int, token_id: int) -> bool:
        """Disable one token; missing/already-disabled tokens are reconciled."""
        existing = self.get_relay_token(dashboard_token=dashboard_token, user_id=user_id, token_id=token_id)
        if existing is None:
            # A successful delete or an already-removed token is the desired
            # terminal state.  This makes a retry after an unknown DELETE safe.
            return False
        try:
            current_status = int(str(existing.get("status")))
        except (TypeError, ValueError):
            current_status = 1
        if current_status != 1:
            # Already disabled/expired is terminal, but it is not a newly
            # observed revocation timestamp.
            return False
        self._request(
            "PUT",
            "/api/token/?status_only=true",
            token=dashboard_token,
            user_id=user_id,
            json={"id": token_id, "status": 2},
        )
        return True

    # Explicit spellings for lifecycle callers.
    disable_relay_token = revoke_relay_token
    revoke_token = revoke_relay_token

    def delete_relay_token(
        self,
        *,
        dashboard_token: str,
        user_id: int,
        token_id: int,
        missing_ok: bool = False,
    ) -> bool:
        """Delete a token through rc.25's proven DELETE /api/token/:id route."""
        # Reconcile first so a retry after a successful DELETE is terminal and
        # does not depend on the upstream's exact not-found error envelope.
        if self.get_relay_token(dashboard_token=dashboard_token, user_id=user_id, token_id=token_id) is None:
            return False
        try:
            self._request("DELETE", f"/api/token/{token_id}", token=dashboard_token, user_id=user_id)
        except NewApiError as exc:
            if missing_ok and "HTTP 404" in str(exc):
                return False
            raise
        return True

    # Compatibility spelling used by a few maintenance adapters.
    delete_token = delete_relay_token

    @staticmethod
    def _matching_token(items: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
        matches = [item for item in items if item.get("name") == name]
        if len(matches) > 1:
            ids = sorted(str(item.get("id")) for item in matches)
            raise NewApiError(f"NewAPI relay token name is ambiguous: {name} ({', '.join(ids)})")
        return matches[0] if matches else None

    @staticmethod
    def _has_complete_token_metadata(item: dict[str, Any]) -> bool:
        required = {"status", "expired_time", "model_limits_enabled", "model_limits"}
        return all(name in item and item[name] is not None for name in required)

    def _validate_token_metadata(
        self,
        item: dict[str, Any],
        *,
        model_ids: list[str],
        expired_time: int,
    ) -> None:
        """Require complete status/scope/expiry metadata for token reuse."""
        try:
            status = int(str(item["status"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise NewApiError("NewAPI created relay token returned invalid status") from exc
        if status != 1:
            raise NewApiError("NewAPI created relay token is not enabled")
        if item.get("model_limits_enabled") is not True:
            raise NewApiError("NewAPI created relay token has unrestricted model scope")
        raw_limits = item.get("model_limits")
        if raw_limits is None:
            raise NewApiError("NewAPI created relay token returned no model scope")
        actual = {
            value.strip() for value in self._model_limits(raw_limits).split(",") if value.strip()
        }
        desired = {value.strip() for value in model_ids if value.strip()}
        if actual != desired:
            raise NewApiError("NewAPI created relay token scope does not match requested models")
        try:
            remote_expiry = int(str(item["expired_time"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise NewApiError("NewAPI relay token returned invalid expiry") from exc
        if (
            (expired_time == -1 and remote_expiry != -1)
            or (expired_time != -1 and (remote_expiry == -1 or remote_expiry < expired_time))
        ):
            raise NewApiError("NewAPI relay token expiry is shorter than requested")

    _validate_created_token = _validate_token_metadata

    def _resolve_created_token(
        self,
        *,
        dashboard_token: str,
        user_id: int,
        name: str,
        model_ids: list[str],
        expired_time: int,
    ) -> dict[str, Any]:
        # NewAPI persists token creation asynchronously. Poll only after the POST;
        # never retry the POST, because a retry could create an untracked duplicate.
        for attempt in range(5):
            match = self._matching_token(self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id), name)
            if match is not None:
                try:
                    metadata = match
                    if not self._has_complete_token_metadata(metadata):
                        token_id = self._token_id(match)
                        if token_id is None:
                            raise NewApiError("NewAPI returned an invalid relay token id")
                        metadata = self.get_relay_token_detail(
                            dashboard_token=dashboard_token,
                            user_id=user_id,
                            token_id=token_id,
                        )
                    self._validate_created_token(
                        metadata, model_ids=model_ids, expired_time=expired_time,
                    )
                except NewApiError as exc:
                    token_id = self._token_id(match)
                    if token_id is not None:
                        raise NewApiError(str(exc), token_id=token_id) from exc
                    raise
                return match | metadata
            if attempt < 4:
                time.sleep(0.2 * (attempt + 1))
        raise NewApiError(f"NewAPI created relay token was not observable: {name}")

    def create_relay_token(self, *, dashboard_token: str, user_id: int, name: str, model_ids: list[str], remain_quota: int, expired_time: int = -1) -> tuple[int, str]:
        # Resolve an existing deterministic name first. This makes retries after a
        # successful POST idempotent and prevents another duplicate token.
        existing = self._matching_token(self._list_user_tokens(dashboard_token=dashboard_token, user_id=user_id), name)
        if existing is not None:
            # A deterministic-name retry may only reuse a token after complete
            # metadata validation.  If list metadata is incomplete, fetch the
            # verified detail record; never treat id/name alone as proof.
            try:
                metadata = existing
                if not self._has_complete_token_metadata(metadata):
                    token_id = self._token_id(existing)
                    if token_id is None:
                        raise NewApiError("NewAPI returned an invalid relay token id")
                    metadata = self.get_relay_token_detail(
                        dashboard_token=dashboard_token, user_id=user_id,
                        token_id=token_id,
                    )
                self._validate_token_metadata(
                    metadata, model_ids=model_ids, expired_time=expired_time,
                )
            except NewApiError as exc:
                token_id = self._token_id(existing)
                if token_id is not None:
                    raise NewApiError(str(exc), token_id=token_id) from exc
                raise
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
            existing = self._resolve_created_token(
                dashboard_token=dashboard_token,
                user_id=user_id,
                name=name,
                model_ids=model_ids,
                expired_time=expired_time,
            )
        token_id_raw = existing.get("id")
        try:
            token_id = int(str(token_id_raw))
        except (TypeError, ValueError) as exc:
            raise NewApiError("NewAPI returned an invalid relay token id") from exc
        # rc.25's verified GET /api/token/:id is the only retrieval contract
        # used here.  A masked key is not a credential and must fail closed;
        # never fall back to an unverified endpoint or guess from list data.
        try:
            key = self.get_relay_token_key(
                dashboard_token=dashboard_token,
                user_id=user_id,
                token_id=token_id,
                model_ids=model_ids,
                expired_time=expired_time,
            )
        except NewApiError as exc:
            raise NewApiError(str(exc), token_id=token_id) from exc
        return token_id, key
