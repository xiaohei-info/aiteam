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
from .openapi_schemas import McpCatalogEntryOut, McpMarketOut, McpOAuthClientOut


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
        crypto=getattr(request.app.state, "_crypto_service", None),
        audit=getattr(request.app.state, "_enterprise_audit_repository", None),
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

    @router.get("/grants/mcp-servers", summary="列出可自行安装的 MCP", description="列出本企业已启用、当前成员可自行安装的平台 MCP（含需鉴权的：成员在本机自行登录或填写令牌）。只读，不含任何凭据。", operation_id="manager_grants_installable_mcp_servers")
    def installable(request: Request, claims: TokenClaims = Depends(require)) -> ListEnvelope[InstallableMcpServer]:
        return ListEnvelope(data=_service(request).installable(tenant_context_from(claims)))

    @router.get("/grants/mcp-servers/{server_id}/oauth-client", summary="取平台预登记的 MCP 应用", description="成员本机 Agent 仅在登录 / 刷新令牌时调用，取回平台为该 MCP 登记的应用编号与密钥；只放内存，不落盘。仅本企业已启用、oauth 且平台已登记应用的条目。", operation_id="manager_grants_mcp_oauth_client")
    def oauth_client(server_id: str, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpOAuthClientOut]:
        return Envelope(data=McpOAuthClientOut(**_service(request).oauth_client(tenant_context_from(claims), server_id)))

    return router
