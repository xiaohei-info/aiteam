"""Operator platform MCP catalog storage (design §11.3, MCP 鉴权 2026-11-18 §3.8 / §3.10)."""

from __future__ import annotations

import os
from typing import Any

from shared.contracts.platform_mcp import (
    PlatformMcpServer,
    PlatformMcpServerFields,
    PlatformMcpServerPull,
)
from shared.errors import Conflict, NotFound, ServiceUnavailable, ValidationProblem

_FIELDS = "id, ref, display_name, summary, url, tools, auth, auth_header, oauth_scopes, timeout_ms, oauth_client_id, revision, status"
_COLS = _FIELDS + ", oauth_client_secret_enc IS NOT NULL"
_PULL_COLS = _FIELDS + ", oauth_client_secret_enc"
_STATUSES = {"published", "unpublished"}


def _fields(row: Any) -> dict:
    return {
        "server_id": str(row[0]), "ref": row[1], "display_name": row[2], "summary": row[3], "url": row[4],
        "tools": list(row[5] or []), "auth": row[6], "auth_header": row[7], "oauth_scopes": row[8],
        "timeout_ms": int(row[9]), "oauth_client_id": row[10], "revision": int(row[11]), "status": row[12],
    }


def _row(row: Any) -> PlatformMcpServer:
    return PlatformMcpServer(**_fields(row), oauth_client_secret_set=bool(row[13]))


class _SecretCipher:
    """Fernet with the Operator provider credential key — same protection as platform Provider tokens."""

    def __init__(self, crypto=None):
        self._crypto = crypto

    def _get(self):
        if self._crypto is None:
            key = os.getenv("OPERATION_PROVIDER_CREDENTIAL_KEY")
            if not key:
                raise ServiceUnavailable("Operator credential encryption is not configured")
            from cryptography.fernet import Fernet

            from shared.crypto import CryptoService
            try:
                self._crypto = CryptoService(Fernet(key.encode()))
            except ValueError as exc:
                raise ServiceUnavailable("Operator credential encryption is not configured") from exc
        return self._crypto

    def encrypt(self, value: str) -> bytes:
        return self._get().encrypt(value)

    def decrypt(self, value: bytes) -> str:
        return self._get().decrypt(bytes(value))


def _next_secret(body: PlatformMcpServerFields, current: bytes | None, cipher: _SecretCipher) -> bytes | None:
    """None = keep, "" = clear, other = replace; meaningless once the entry is not a preregistered OAuth client."""
    if body.auth != "oauth" or not body.oauth_client_id:
        return None
    if body.oauth_client_secret is None:
        return current
    return cipher.encrypt(body.oauth_client_secret) if body.oauth_client_secret else None


class PlatformMcpRepository:
    """Single writer of `platform_mcp_server` (Operator DB)."""

    def __init__(self, dsn: str, crypto=None):
        self._dsn = dsn
        self._cipher = _SecretCipher(crypto)

    def _connect(self, *, autocommit: bool):
        import psycopg
        return psycopg.connect(self._dsn, autocommit=autocommit)

    def list(self, *, status: str | None = None) -> list[PlatformMcpServer]:
        sql = "SELECT " + _COLS + " FROM platform_mcp_server"
        args: list[Any] = []
        if status:
            sql += " WHERE status=%s"
            args.append(status)
        sql += " ORDER BY display_name, ref"
        with self._connect(autocommit=True) as conn:
            return [_row(r) for r in conn.execute(sql, args).fetchall()]

    def list_for_pull(self) -> list[PlatformMcpServerPull]:
        """Published entries with the decrypted application secret, for the Manager service pull only."""
        with self._connect(autocommit=True) as conn:
            rows = conn.execute(
                "SELECT " + _PULL_COLS + " FROM platform_mcp_server WHERE status='published' ORDER BY display_name, ref",
            ).fetchall()
        return [
            PlatformMcpServerPull(
                **_fields(r), oauth_client_secret_set=r[13] is not None,
                oauth_client_secret=self._cipher.decrypt(r[13]) if r[13] is not None else "",
            )
            for r in rows
        ]

    def get(self, server_id: str) -> PlatformMcpServer:
        with self._connect(autocommit=True) as conn:
            row = conn.execute("SELECT " + _COLS + " FROM platform_mcp_server WHERE id::text=%s", (server_id,)).fetchone()
        if row is None:
            raise NotFound("platform MCP server not found")
        return _row(row)

    def create(self, body: PlatformMcpServerFields) -> PlatformMcpServer:
        import psycopg
        from psycopg.types.json import Json
        secret = _next_secret(body, None, self._cipher)
        try:
            with self._connect(autocommit=True) as conn:
                row = conn.execute(
                    "INSERT INTO platform_mcp_server (ref, display_name, summary, url, tools, auth, auth_header, oauth_scopes, "
                    "timeout_ms, oauth_client_id, oauth_client_secret_enc) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING " + _COLS,
                    (body.ref, body.display_name, body.summary, body.url, Json(body.tools), body.auth, body.auth_header,
                     body.oauth_scopes, body.timeout_ms, body.oauth_client_id, secret),
                ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise Conflict(f"标识 {body.ref} 已被其他 MCP 使用") from exc
        return _row(row)

    def update(self, server_id: str, body: PlatformMcpServerFields) -> PlatformMcpServer:
        """Every edit bumps `revision`; the ref is immutable (members install under it)."""
        from psycopg.types.json import Json
        with self._connect(autocommit=False) as conn:
            current = conn.execute(
                "SELECT ref, oauth_client_secret_enc FROM platform_mcp_server WHERE id::text=%s FOR UPDATE", (server_id,),
            ).fetchone()
            if current is None:
                raise NotFound("platform MCP server not found")
            if current[0] != body.ref:
                raise Conflict("标识创建后不能修改")
            secret = _next_secret(body, current[1], self._cipher)
            row = conn.execute(
                "UPDATE platform_mcp_server SET display_name=%s, summary=%s, url=%s, tools=%s, auth=%s, auth_header=%s, "
                "oauth_scopes=%s, timeout_ms=%s, oauth_client_id=%s, oauth_client_secret_enc=%s, revision=revision+1 "
                "WHERE id::text=%s RETURNING " + _COLS,
                (body.display_name, body.summary, body.url, Json(body.tools), body.auth, body.auth_header, body.oauth_scopes,
                 body.timeout_ms, body.oauth_client_id, secret, server_id),
            ).fetchone()
            conn.commit()
        return _row(row)

    def set_status(self, server_id: str, status: str) -> PlatformMcpServer:
        if status not in _STATUSES:
            raise ValidationProblem("invalid platform MCP status")
        with self._connect(autocommit=True) as conn:
            row = conn.execute(
                "UPDATE platform_mcp_server SET status=%s WHERE id::text=%s RETURNING " + _COLS, (status, server_id),
            ).fetchone()
        if row is None:
            raise NotFound("platform MCP server not found")
        return _row(row)
