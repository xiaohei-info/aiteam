"""Operator platform MCP catalog storage (design §11.3)."""

from __future__ import annotations

from typing import Any

from shared.contracts.platform_mcp import PlatformMcpServer, PlatformMcpServerFields
from shared.errors import Conflict, NotFound, ValidationProblem

_COLS = "id, ref, display_name, summary, url, tools, requires_credentials, revision, status"
_STATUSES = {"published", "unpublished"}


def _row(row: Any) -> PlatformMcpServer:
    return PlatformMcpServer(
        server_id=str(row[0]), ref=row[1], display_name=row[2], summary=row[3], url=row[4],
        tools=list(row[5] or []), requires_credentials=bool(row[6]), revision=int(row[7]), status=row[8],
    )


class PlatformMcpRepository:
    """Single writer of `platform_mcp_server` (Operator DB)."""

    def __init__(self, dsn: str):
        self._dsn = dsn

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

    def get(self, server_id: str) -> PlatformMcpServer:
        with self._connect(autocommit=True) as conn:
            row = conn.execute("SELECT " + _COLS + " FROM platform_mcp_server WHERE id::text=%s", (server_id,)).fetchone()
        if row is None:
            raise NotFound("platform MCP server not found")
        return _row(row)

    def create(self, body: PlatformMcpServerFields) -> PlatformMcpServer:
        import psycopg
        from psycopg.types.json import Json
        try:
            with self._connect(autocommit=True) as conn:
                row = conn.execute(
                    "INSERT INTO platform_mcp_server (ref, display_name, summary, url, tools, requires_credentials) "
                    "VALUES (%s,%s,%s,%s,%s,%s) RETURNING " + _COLS,
                    (body.ref, body.display_name, body.summary, body.url, Json(body.tools), body.requires_credentials),
                ).fetchone()
        except psycopg.errors.UniqueViolation as exc:
            raise Conflict(f"标识 {body.ref} 已被其他 MCP 使用") from exc
        return _row(row)

    def update(self, server_id: str, body: PlatformMcpServerFields) -> PlatformMcpServer:
        """Every edit bumps `revision`; the ref is immutable (members install under it)."""
        from psycopg.types.json import Json
        with self._connect(autocommit=False) as conn:
            current = conn.execute("SELECT ref FROM platform_mcp_server WHERE id::text=%s FOR UPDATE", (server_id,)).fetchone()
            if current is None:
                raise NotFound("platform MCP server not found")
            if current[0] != body.ref:
                raise Conflict("标识创建后不能修改")
            row = conn.execute(
                "UPDATE platform_mcp_server SET display_name=%s, summary=%s, url=%s, tools=%s, requires_credentials=%s, "
                "revision=revision+1 WHERE id::text=%s RETURNING " + _COLS,
                (body.display_name, body.summary, body.url, Json(body.tools), body.requires_credentials, server_id),
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
