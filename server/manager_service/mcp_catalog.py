"""Enterprise MCP catalog: enable Operator platform MCP servers for this tenant (design §11.3).

Single writer of `mcp_catalog` (tenant data space, RLS). Enabling copies the platform entry and pins its
revision; members may install enabled entries (`GET /grants/mcp-servers`). Entries that need authentication are
installable too: each member signs in / fills a token on their own machine — Manager never holds member tokens.
A platform-preregistered OAuth application secret is re-encrypted with Manager's key and handed to a member's
Agent only at sign-in (`GET /grants/mcp-servers/{id}/oauth-client`). Design 2026-11-18 MCP鉴权与配置导入.
Disabling or a platform unpublish never touches what members already installed (§11.5).

Enterprise-built entries (design 2026-11-20 §4.4) live in the same table with `origin='enterprise'`: an admin
registers them directly (`server_id = 'ent-' || uuid`, revision from 1, +1 per edit, `ref` fixed once created).
They are installable by members like platform entries but are never eligible for the Agent's auto-install.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from shared.contracts.crosstier import InstallableMcpServer
from shared.contracts.platform_mcp import PlatformMcpServerFields, PlatformMcpServerPull
from shared.contracts.tenancy import TenantContext
from shared.crypto import CryptoService
from shared.db import PgTenantRouter
from shared.errors import AppError, Conflict, NotFound, ValidationProblem
from shared.mcp_probe import McpProbeRequest, McpProbeResult, probe_mcp

from .active_principal import require_active, require_admin
from .operator_catalog import OperatorCatalogPort

_COLS = ("server_id, ref, display_name, summary, url, tools, auth, auth_header, oauth_scopes, timeout_ms, "
         "oauth_client_id, oauth_client_secret_enc IS NOT NULL, source_revision, origin")
ENTERPRISE_PREFIX = "ent-"
McpOrigin = Literal["platform", "enterprise"]


@dataclass(frozen=True)
class McpCatalogRow:
    server_id: str
    ref: str
    display_name: str
    summary: str
    url: str
    tools: list[str]
    auth: str
    auth_header: str
    oauth_scopes: str
    timeout_ms: int
    oauth_client_id: str
    oauth_client_secret_set: bool
    source_revision: int
    origin: McpOrigin = "platform"

    @property
    def oauth_client(self) -> str:
        """`preregistered` when the platform supplied an application id; else the Agent registers dynamically."""
        return "preregistered" if self.auth == "oauth" and self.oauth_client_id else "dynamic"


def _row(row: Any) -> McpCatalogRow:
    return McpCatalogRow(
        server_id=row[0], ref=row[1], display_name=row[2], summary=row[3], url=row[4],
        tools=list(row[5] or []), auth=row[6], auth_header=row[7], oauth_scopes=row[8], timeout_ms=int(row[9]),
        oauth_client_id=row[10], oauth_client_secret_set=bool(row[11]), source_revision=int(row[12]), origin=row[13],
    )


_KEEP = object()  # update_custom: leave the stored application secret as it is


class McpCatalogRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list(self, ctx: TenantContext) -> list[McpCatalogRow]:
        with self._router.session(ctx) as s:
            rows = s.execute("SELECT " + _COLS + " FROM mcp_catalog ORDER BY display_name, ref").fetchall()
        return [_row(r) for r in rows]

    def get(self, ctx: TenantContext, server_id: str) -> McpCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute("SELECT " + _COLS + " FROM mcp_catalog WHERE server_id = %s", (server_id,)).fetchone()
        return _row(row) if row else None

    def oauth_client(self, ctx: TenantContext, server_id: str) -> tuple[str, str, bytes | None] | None:
        """(auth, client_id, encrypted secret) of an enabled entry; None when not enabled."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT auth, oauth_client_id, oauth_client_secret_enc FROM mcp_catalog WHERE server_id = %s", (server_id,),
            ).fetchone()
        return (row[0], row[1], bytes(row[2]) if row[2] is not None else None) if row else None

    def upsert(self, ctx: TenantContext, server: PlatformMcpServerPull, *, enabled_by: str, secret_enc: bytes | None = None) -> McpCatalogRow:
        """Enable or move to the platform's current revision. A ref held by another server is a conflict."""
        from psycopg.types.json import Json
        with self._router.session(ctx) as s:
            clash = s.execute(
                "SELECT server_id FROM mcp_catalog WHERE ref = %s AND server_id <> %s", (server.ref, server.server_id),
            ).fetchone()
            if clash is not None:
                raise Conflict(f"本企业已启用标识为 {server.ref} 的其他 MCP，请先停用")
            row = s.execute(
                "INSERT INTO mcp_catalog (tenant_id, server_id, ref, display_name, summary, url, tools, auth, auth_header, "
                "oauth_scopes, timeout_ms, oauth_client_id, oauth_client_secret_enc, source_revision, enabled_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (tenant_id, server_id) DO UPDATE SET ref = EXCLUDED.ref, display_name = EXCLUDED.display_name, "
                "summary = EXCLUDED.summary, url = EXCLUDED.url, tools = EXCLUDED.tools, auth = EXCLUDED.auth, "
                "auth_header = EXCLUDED.auth_header, oauth_scopes = EXCLUDED.oauth_scopes, timeout_ms = EXCLUDED.timeout_ms, "
                "oauth_client_id = EXCLUDED.oauth_client_id, oauth_client_secret_enc = EXCLUDED.oauth_client_secret_enc, "
                "source_revision = EXCLUDED.source_revision, enabled_by = EXCLUDED.enabled_by, updated_at = now() RETURNING " + _COLS,
                (ctx.tenant_id, server.server_id, server.ref, server.display_name, server.summary, server.url,
                 Json(server.tools), server.auth, server.auth_header, server.oauth_scopes, server.timeout_ms,
                 server.oauth_client_id, secret_enc, server.revision, enabled_by),
            ).fetchone()
        return _row(row)

    def create_custom(self, ctx: TenantContext, fields: PlatformMcpServerFields, *, server_id: str, created_by: str,
                      secret_enc: bytes | None) -> McpCatalogRow:
        """Registers an enterprise-built entry at revision 1. A ref already in this tenant's catalog is a conflict."""
        from psycopg.types.json import Json
        with self._router.session(ctx) as s:
            if s.execute("SELECT 1 FROM mcp_catalog WHERE ref = %s", (fields.ref,)).fetchone() is not None:
                raise Conflict(f"本企业目录里已有标识为 {fields.ref} 的 MCP，请换一个标识")
            row = s.execute(
                "INSERT INTO mcp_catalog (tenant_id, server_id, ref, display_name, summary, url, tools, auth, auth_header, "
                "oauth_scopes, timeout_ms, oauth_client_id, oauth_client_secret_enc, source_revision, enabled_by, origin) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s,'enterprise') RETURNING " + _COLS,
                (ctx.tenant_id, server_id, fields.ref, fields.display_name, fields.summary, fields.url, Json(fields.tools),
                 fields.auth, fields.auth_header, fields.oauth_scopes, fields.timeout_ms, fields.oauth_client_id,
                 secret_enc, created_by),
            ).fetchone()
        return _row(row)

    def update_custom(self, ctx: TenantContext, server_id: str, fields: PlatformMcpServerFields, *, updated_by: str,
                      secret_enc: Any = _KEEP) -> McpCatalogRow | None:
        """Edits an enterprise-built entry and bumps its revision; `ref` never changes. None when it does not exist.

        The stored application secret is kept unless `secret_enc` is given (None clears it); it is cleared anyway
        when the entry no longer uses a preregistered OAuth application.
        """
        from psycopg.types.json import Json
        keep = secret_enc is _KEEP
        keeps_app = fields.auth == "oauth" and bool(fields.oauth_client_id)
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE mcp_catalog SET display_name = %s, summary = %s, url = %s, tools = %s, auth = %s, auth_header = %s, "
                "oauth_scopes = %s, timeout_ms = %s, oauth_client_id = %s, "
                "oauth_client_secret_enc = CASE WHEN NOT %s THEN NULL WHEN %s THEN oauth_client_secret_enc ELSE %s END, "
                "source_revision = source_revision + 1, enabled_by = %s, updated_at = now() "
                "WHERE server_id = %s AND origin = 'enterprise' RETURNING " + _COLS,
                (fields.display_name, fields.summary, fields.url, Json(fields.tools), fields.auth, fields.auth_header,
                 fields.oauth_scopes, fields.timeout_ms, fields.oauth_client_id, keeps_app, keep,
                 None if keep else secret_enc, updated_by, server_id),
            ).fetchone()
        return _row(row) if row else None

    def delete(self, ctx: TenantContext, server_id: str) -> bool:
        with self._router.session(ctx) as s:
            return s.execute("DELETE FROM mcp_catalog WHERE server_id = %s RETURNING server_id", (server_id,)).fetchone() is not None


_MARKET_FIELDS = {"server_id", "ref", "display_name", "summary", "url", "tools", "auth", "auth_header", "oauth_scopes", "timeout_ms"}


class McpMarketService:
    def __init__(self, *, operator: OperatorCatalogPort, repo: McpCatalogRepository, members, crypto: CryptoService | None = None,
                 audit=None, probe: Callable[[McpProbeRequest], McpProbeResult] | None = None):
        self._operator = operator
        self._repo = repo
        self._members = members
        self._crypto = crypto or CryptoService()
        # 审计端口（可选：单元测试可留空；真实装配见 routes_mcp_market）。
        self._audit = audit
        self._probe = probe or probe_mcp

    def _platform(self) -> list[PlatformMcpServerPull]:
        return [PlatformMcpServerPull.model_validate(item) for item in self._operator.list_platform_mcp_servers()]

    def list_market(self, ctx: TenantContext) -> dict:
        """Platform-published entries merged with this tenant's enabled copies.

        If Operator is unreachable (or predates the MCP catalog), enabled entries are still listed so an
        admin can disable them; `platform_available` tells the page why nothing new can be enabled.
        """
        rows = self._repo.list(ctx)
        enabled = {row.server_id: row for row in rows if row.origin == "platform"}
        try:
            platform = self._platform()
            available = True
        except AppError:
            platform, available = [], False
        items: list[dict] = []
        for server in platform:
            row = enabled.pop(server.server_id, None)
            items.append({
                **server.model_dump(include=_MARKET_FIELDS),
                "oauth_client": "preregistered" if server.auth == "oauth" and server.oauth_client_id else "dynamic",
                "platform_revision": server.revision, "published": True,
                "enabled": row is not None, "enabled_revision": row.source_revision if row else None,
                "update_available": row is not None and row.source_revision != server.revision,
            })
        for row in enabled.values():  # enabled earlier, now unpublished on the platform (or platform unreachable)
            items.append({
                "server_id": row.server_id, "ref": row.ref, "display_name": row.display_name, "summary": row.summary,
                "url": row.url, "tools": row.tools, "auth": row.auth, "auth_header": row.auth_header,
                "oauth_scopes": row.oauth_scopes, "timeout_ms": row.timeout_ms, "oauth_client": row.oauth_client,
                "platform_revision": None, "published": False, "enabled": True,
                "enabled_revision": row.source_revision, "update_available": False,
            })
        enterprise = [enterprise_entry(row) for row in rows if row.origin == "enterprise"]
        return {"platform_available": available, "servers": items, "enterprise": enterprise}

    def enable(self, ctx: TenantContext, server_id: str) -> McpCatalogRow:
        require_admin(ctx)
        server = next((item for item in self._platform() if item.server_id == server_id), None)
        if server is None:
            raise NotFound("平台目录中没有该 MCP，或已下架")
        secret = self._crypto.encrypt(server.oauth_client_secret) if server.oauth_client_secret and server.oauth_client_id else None
        return self._repo.upsert(ctx, server, enabled_by=ctx.user_id, secret_enc=secret)

    def disable(self, ctx: TenantContext, server_id: str) -> None:
        """Disables a platform entry or deletes an enterprise-built one; members' installs are not touched."""
        require_admin(ctx)
        if not self._repo.delete(ctx, server_id):
            raise NotFound("本企业未启用该 MCP")
        if server_id.startswith(ENTERPRISE_PREFIX):
            self._record(ctx, "mcp_catalog.custom_deleted", server_id)

    def probe(self, ctx: TenantContext, request: McpProbeRequest) -> McpProbeResult:
        """Admin-only: connects once (SSRF-guarded, nothing stored) to read the auth mode and tools."""
        require_admin(ctx)
        return self._probe(request)

    def create_custom(self, ctx: TenantContext, fields: PlatformMcpServerFields) -> McpCatalogRow:
        require_admin(ctx)
        server_id = ENTERPRISE_PREFIX + str(uuid.uuid4())
        row = self._repo.create_custom(ctx, fields, server_id=server_id, created_by=ctx.user_id,
                                       secret_enc=self._encrypt_secret(fields))
        self._record(ctx, "mcp_catalog.custom_created", server_id)
        return row

    def update_custom(self, ctx: TenantContext, server_id: str, fields: PlatformMcpServerFields) -> McpCatalogRow:
        require_admin(ctx)
        current = self._repo.get(ctx, server_id)
        if current is None or current.origin != "enterprise":
            raise NotFound("本企业没有这个自建 MCP")
        if fields.ref != current.ref:
            raise ValidationProblem("标识创建后不能修改；成员本机按标识安装")
        secret: Any = _KEEP if fields.oauth_client_secret is None else self._encrypt_secret(fields)
        row = self._repo.update_custom(ctx, server_id, fields, updated_by=ctx.user_id, secret_enc=secret)
        if row is None:
            raise NotFound("本企业没有这个自建 MCP")
        self._record(ctx, "mcp_catalog.custom_updated", server_id)
        return row

    def _encrypt_secret(self, fields: PlatformMcpServerFields) -> bytes | None:
        """Write-only application secret, encrypted with Manager's key; empty clears it."""
        if fields.auth != "oauth" or not fields.oauth_client_id or not fields.oauth_client_secret:
            return None
        return self._crypto.encrypt(fields.oauth_client_secret)

    def _record(self, ctx: TenantContext, action: str, server_id: str) -> None:
        if self._audit is not None:
            self._audit.record(ctx, actor=ctx.user_id, action=action, resource_type="mcp_server", resource_id=server_id)

    def installable(self, ctx: TenantContext) -> list[InstallableMcpServer]:
        """Enabled entries an active member may install for themselves; credentials stay with the member."""
        require_active(self._members.get_member(ctx, ctx.user_id))
        return [
            InstallableMcpServer(
                server_id=row.server_id, ref=row.ref, display_name=row.display_name, summary=row.summary,
                url=row.url, tools=row.tools, revision=row.source_revision, auth=row.auth, auth_header=row.auth_header,
                oauth_scopes=row.oauth_scopes, timeout_ms=row.timeout_ms, oauth_client=row.oauth_client, origin=row.origin,
            )
            for row in self._repo.list(ctx)
        ]

    def oauth_client(self, ctx: TenantContext, server_id: str) -> dict:
        """平台或企业预登记的 OAuth 应用，供成员本机 Agent 登录 / 刷新令牌。

        按需下发（设计 2026-11-19 §3.4）：本机 Agent 只在登录 / 刷新令牌用到时才请求，内存持有不落盘。
        下发前校验企业已启用该 MCP、成员在职；每次下发记一条审计。
        """
        require_active(self._members.get_member(ctx, ctx.user_id))
        found = self._repo.oauth_client(ctx, server_id)
        if found is None or found[0] != "oauth" or not found[1]:
            raise NotFound("本企业目录中没有该 MCP 的预登记应用")
        _auth, client_id, secret = found
        result = {"client_id": client_id, **({"client_secret": self._crypto.decrypt(secret)} if secret else {})}
        if self._audit is not None:
            self._audit.record(ctx, actor=ctx.user_id, action="mcp.oauth_client.issued",
                               resource_type="mcp_server", resource_id=server_id)
        return result


def enterprise_entry(row: McpCatalogRow) -> dict:
    """An enterprise-built entry as admins see it; the application secret is never returned."""
    return {
        "server_id": row.server_id, "ref": row.ref, "display_name": row.display_name, "summary": row.summary,
        "url": row.url, "tools": row.tools, "auth": row.auth, "auth_header": row.auth_header,
        "oauth_scopes": row.oauth_scopes, "timeout_ms": row.timeout_ms, "oauth_client_id": row.oauth_client_id,
        "oauth_client_secret_set": row.oauth_client_secret_set, "revision": row.source_revision,
    }
