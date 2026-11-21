"""Manager enterprise MCP market, enterprise-built MCP and member installable list (design §11.3, 2026-11-20 §4.4)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import InstallableMcpServer
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.platform_mcp import PlatformMcpServerFields
from shared.db import PgTenantRouter
from shared.errors import AppError
from shared.mcp_probe import McpProbeRequest, McpProbeResult

from .enterprise_audit_repository import build_enterprise_audit_repository
from .mcp_catalog import McpCatalogRepository, McpMarketService, enterprise_entry
from .openapi_schemas import (
    McpCatalogEntryOut,
    McpEnterpriseServerOut,
    McpMarketOut,
    McpOAuthClientOut,
)


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
        audit=getattr(request.app.state, "_enterprise_audit_repository", None) or build_enterprise_audit_repository(router),
        probe=getattr(request.app.state, "_mcp_probe", None),
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

    @router.post("/mcp-market/probe", summary="探测 MCP", description="登记企业 MCP 前连接一次：判断鉴权方式、读取工具列表，不保存任何内容。仅 https，拒绝内网/本机/保留地址，不跟随重定向，10 秒超时；test_token 只用于这一次，不保存、不记日志（owner / enterprise_admin）。", operation_id="manager_mcp_market_probe")
    def probe(body: McpProbeRequest, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpProbeResult]:
        return Envelope(data=_service(request).probe(tenant_context_from(claims), body))

    @router.post("/mcp-market/custom", summary="登记企业 MCP", description="企业自己登记一个 MCP（无需鉴权 / 成员浏览器登录 / 成员访问令牌），登记后成员即可自行安装；不参与「以后自动安装」。应用密钥只写不读，加密保存（owner / enterprise_admin）。", operation_id="manager_mcp_market_custom_create", status_code=status.HTTP_201_CREATED)
    def create_custom(body: PlatformMcpServerFields, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpEnterpriseServerOut]:
        row = _service(request).create_custom(tenant_context_from(claims), body)
        return Envelope(data=McpEnterpriseServerOut(**enterprise_entry(row)))

    @router.put("/mcp-market/custom/{server_id}", summary="修改企业 MCP", description="修改企业自建 MCP；标识不能改，每次修改修订号加 1，成员本机据此提示更新。应用密钥不传保持不变、空字符串清除（owner / enterprise_admin）。", operation_id="manager_mcp_market_custom_update")
    def update_custom(server_id: str, body: PlatformMcpServerFields, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpEnterpriseServerOut]:
        row = _service(request).update_custom(tenant_context_from(claims), server_id, body)
        return Envelope(data=McpEnterpriseServerOut(**enterprise_entry(row)))

    @router.delete("/mcp-market/{server_id}", summary="停用平台 MCP / 删除企业 MCP", description="平台条目从本企业目录停用；企业自建条目删除。成员已安装的不受影响（owner / enterprise_admin）。", operation_id="manager_mcp_market_disable", status_code=status.HTTP_204_NO_CONTENT)
    def disable(server_id: str, request: Request, claims: TokenClaims = Depends(require)) -> None:
        _service(request).disable(tenant_context_from(claims), server_id)

    @router.get("/grants/mcp-servers", summary="列出可自行安装的 MCP", description="列出当前成员可自行安装的 MCP：本企业从平台启用的与企业自建的（origin 区分；含需鉴权的：成员在本机自行登录或填写令牌）。只读，不含任何凭据。", operation_id="manager_grants_installable_mcp_servers")
    def installable(request: Request, claims: TokenClaims = Depends(require)) -> ListEnvelope[InstallableMcpServer]:
        return ListEnvelope(data=_service(request).installable(tenant_context_from(claims)))

    @router.get("/grants/mcp-servers/{server_id}/oauth-client", summary="取预登记的 MCP 应用", description="成员本机 Agent 仅在登录 / 刷新令牌时调用，取回平台或企业为该 MCP 登记的应用编号与密钥；只放内存，不落盘。仅本企业目录中、oauth 且已登记应用的条目。", operation_id="manager_grants_mcp_oauth_client")
    def oauth_client(server_id: str, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[McpOAuthClientOut]:
        return Envelope(data=McpOAuthClientOut(**_service(request).oauth_client(tenant_context_from(claims), server_id)))

    return router
