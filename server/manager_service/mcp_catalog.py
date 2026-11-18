"""Enterprise MCP catalog: enable Operator platform MCP servers for this tenant (design §11.3).

Single writer of `mcp_catalog` (tenant data space, RLS). Enabling copies the platform entry and pins its
revision; members may install only enabled entries that need no credentials (`GET /grants/mcp-servers`).
Disabling or a platform unpublish never touches what members already installed (§11.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.contracts.crosstier import InstallableMcpServer
from shared.contracts.platform_mcp import PlatformMcpServer
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import AppError, Conflict, NotFound

from .active_principal import require_active, require_admin
from .operator_catalog import OperatorCatalogPort

_COLS = "server_id, ref, display_name, summary, url, tools, requires_credentials, source_revision"


@dataclass(frozen=True)
class McpCatalogRow:
    server_id: str
    ref: str
    display_name: str
    summary: str
    url: str
    tools: list[str]
    requires_credentials: bool
    source_revision: int


def _row(row: Any) -> McpCatalogRow:
    return McpCatalogRow(
        server_id=row[0], ref=row[1], display_name=row[2], summary=row[3], url=row[4],
        tools=list(row[5] or []), requires_credentials=bool(row[6]), source_revision=int(row[7]),
    )


class McpCatalogRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list(self, ctx: TenantContext) -> list[McpCatalogRow]:
        with self._router.session(ctx) as s:
            rows = s.execute("SELECT " + _COLS + " FROM mcp_catalog ORDER BY display_name, ref").fetchall()
        return [_row(r) for r in rows]

    def upsert(self, ctx: TenantContext, server: PlatformMcpServer, *, enabled_by: str) -> McpCatalogRow:
        """Enable or move to the platform's current revision. A ref held by another server is a conflict."""
        from psycopg.types.json import Json
        with self._router.session(ctx) as s:
            clash = s.execute(
                "SELECT server_id FROM mcp_catalog WHERE ref = %s AND server_id <> %s", (server.ref, server.server_id),
            ).fetchone()
            if clash is not None:
                raise Conflict(f"本企业已启用标识为 {server.ref} 的其他 MCP，请先停用")
            row = s.execute(
                "INSERT INTO mcp_catalog (tenant_id, server_id, ref, display_name, summary, url, tools, requires_credentials, source_revision, enabled_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (tenant_id, server_id) DO UPDATE SET ref = EXCLUDED.ref, display_name = EXCLUDED.display_name, "
                "summary = EXCLUDED.summary, url = EXCLUDED.url, tools = EXCLUDED.tools, "
                "requires_credentials = EXCLUDED.requires_credentials, source_revision = EXCLUDED.source_revision, "
                "enabled_by = EXCLUDED.enabled_by, updated_at = now() RETURNING " + _COLS,
                (ctx.tenant_id, server.server_id, server.ref, server.display_name, server.summary, server.url,
                 Json(server.tools), server.requires_credentials, server.revision, enabled_by),
            ).fetchone()
        return _row(row)

    def delete(self, ctx: TenantContext, server_id: str) -> bool:
        with self._router.session(ctx) as s:
            return s.execute("DELETE FROM mcp_catalog WHERE server_id = %s RETURNING server_id", (server_id,)).fetchone() is not None


class McpMarketService:
    def __init__(self, *, operator: OperatorCatalogPort, repo: McpCatalogRepository, members):
        self._operator = operator
        self._repo = repo
        self._members = members

    def _platform(self) -> list[PlatformMcpServer]:
        return [PlatformMcpServer.model_validate(item) for item in self._operator.list_platform_mcp_servers()]

    def list_market(self, ctx: TenantContext) -> dict:
        """Platform-published entries merged with this tenant's enabled copies.

        If Operator is unreachable (or predates the MCP catalog), enabled entries are still listed so an
        admin can disable them; `platform_available` tells the page why nothing new can be enabled.
        """
        enabled = {row.server_id: row for row in self._repo.list(ctx)}
        try:
            platform = self._platform()
            available = True
        except AppError:
            platform, available = [], False
        items: list[dict] = []
        for server in platform:
            row = enabled.pop(server.server_id, None)
            items.append({
                **server.model_dump(exclude={"status", "revision"}), "platform_revision": server.revision, "published": True,
                "enabled": row is not None, "enabled_revision": row.source_revision if row else None,
                "update_available": row is not None and row.source_revision != server.revision,
            })
        for row in enabled.values():  # enabled earlier, now unpublished on the platform (or platform unreachable)
            items.append({
                "server_id": row.server_id, "ref": row.ref, "display_name": row.display_name, "summary": row.summary,
                "url": row.url, "tools": row.tools, "requires_credentials": row.requires_credentials,
                "platform_revision": None, "published": False, "enabled": True,
                "enabled_revision": row.source_revision, "update_available": False,
            })
        return {"platform_available": available, "servers": items}

    def enable(self, ctx: TenantContext, server_id: str) -> McpCatalogRow:
        require_admin(ctx)
        server = next((item for item in self._platform() if item.server_id == server_id), None)
        if server is None:
            raise NotFound("平台目录中没有该 MCP，或已下架")
        return self._repo.upsert(ctx, server, enabled_by=ctx.user_id)

    def disable(self, ctx: TenantContext, server_id: str) -> None:
        require_admin(ctx)
        if not self._repo.delete(ctx, server_id):
            raise NotFound("本企业未启用该 MCP")

    def installable(self, ctx: TenantContext) -> list[InstallableMcpServer]:
        """Enabled, credential-free entries an active member may install for themselves."""
        require_active(self._members.get_member(ctx, ctx.user_id))
        return [
            InstallableMcpServer(
                server_id=row.server_id, ref=row.ref, display_name=row.display_name, summary=row.summary,
                url=row.url, tools=row.tools, revision=row.source_revision,
            )
            for row in self._repo.list(ctx) if not row.requires_credentials
        ]
