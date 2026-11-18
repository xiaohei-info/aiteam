"""Manager enterprise MCP market and member installable list (design §11.3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import InstallableMcpServer
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .mcp_catalog import McpCatalogRepository, McpMarketService
from .openapi_schemas import McpCatalogEntryOut, McpMarketOut


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> McpMarketService:
    injected = getattr(request.app.state, "_mcp_market_service", None)
    if injected is not None:
        return injected
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager DB is not configured")
    from .member_service import MemberDeptService
    from .repository_member import MemberDeptRepository
    router = PgTenantRouter(dsn)
    service = McpMarketService(
        operator=request.app.state._operator_catalog,
        repo=McpCatalogRepository(router),
        members=MemberDeptService(repo=MemberDeptRepository(router)),
    )
    request.app.state._mcp_market_service = service
    return service


def build_mcp_market_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager", tags=["manager", "mcp-market"])
    require = require_claims(verifier)

    @router.get("/mcp-market", summary="列出平台 MCP 市场", description="列出平台已发布的 MCP 与本企业启用状态；平台不可达时只列出已启用项。", operation_id="manager_mcp_market_list")
    def list_market(request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpMarketOut]:
        return Envelope(data=McpMarketOut(**_service(request).list_market(tenant_context_from(claims))))

    @router.post("/mcp-market/{server_id}/enable", summary="启用平台 MCP", description="把平台已发布的 MCP 启用到本企业目录，或更新到平台当前修订（owner / enterprise_admin）。", operation_id="manager_mcp_market_enable")
    def enable(server_id: str, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpCatalogEntryOut]:
        row = _service(request).enable(tenant_context_from(claims), server_id)
        return Envelope(data=McpCatalogEntryOut(server_id=row.server_id, ref=row.ref, display_name=row.display_name, source_revision=row.source_revision))

    @router.delete("/mcp-market/{server_id}", summary="停用平台 MCP", description="从本企业目录停用；成员已安装的不受影响（owner / enterprise_admin）。", operation_id="manager_mcp_market_disable", status_code=status.HTTP_204_NO_CONTENT)
    def disable(server_id: str, request: Request, claims: TokenClaims = Depends(require)) -> None:
        _service(request).disable(tenant_context_from(claims), server_id)

    @router.get("/grants/mcp-servers", summary="列出可自行安装的 MCP", description="列出本企业已启用、免凭据、当前成员可在对话中自行安装的平台 MCP。只读。", operation_id="manager_grants_installable_mcp_servers")
    def installable(request: Request, claims: TokenClaims = Depends(require)) -> ListEnvelope[InstallableMcpServer]:
        return ListEnvelope(data=_service(request).installable(tenant_context_from(claims)))

    return router
