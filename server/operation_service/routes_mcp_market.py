"""Operator platform MCP catalog: register, publish, and Manager pull (design §11.3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.platform_mcp import PlatformMcpServer, PlatformMcpServerFields
from shared.errors import AppError

from .platform_mcp_market import PlatformMcpRepository

router = APIRouter(prefix="/api/operation/mcp-market", tags=["operation", "mcp-market"])


class _OperatorMcpStoreUnavailable(AppError):
    status, code, title = 503, "operator_mcp_store_unavailable", "Operator MCP store unavailable"


def _claims(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value])
    return claims


def _repo(request: Request) -> PlatformMcpRepository:
    injected = getattr(request.app.state, "_platform_mcp_repository", None)
    if injected is not None:
        return injected
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _OperatorMcpStoreUnavailable("Operator DB is not configured")
    repo = PlatformMcpRepository(dsn)
    request.app.state._platform_mcp_repository = repo
    return repo


@router.get("/servers", summary="列出平台 MCP 目录", description="列出平台登记的全部 MCP（含草稿与已下架）。", operation_id="operation_mcp_market_list")
async def list_servers(request: Request, _claims: TokenClaims = Depends(_claims)) -> ListEnvelope[PlatformMcpServer]:
    return ListEnvelope(data=_repo(request).list())


@router.post("/servers", summary="登记平台 MCP", description="登记一个免凭据或需凭据的 MCP 端点，初始为草稿。", operation_id="operation_mcp_market_create", status_code=status.HTTP_201_CREATED)
async def create_server(body: PlatformMcpServerFields, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformMcpServer]:
    return Envelope(data=_repo(request).create(body))


@router.put("/servers/{server_id}", summary="修改平台 MCP", description="修改名称、用途、地址、工具或凭据要求；标识不可改，每次修改修订号加 1。", operation_id="operation_mcp_market_update")
async def update_server(server_id: str, body: PlatformMcpServerFields, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformMcpServer]:
    return Envelope(data=_repo(request).update(server_id, body))


@router.post("/servers/{server_id}/publish", summary="发布平台 MCP", description="发布后所有企业可在 MCP 市场中启用。", operation_id="operation_mcp_market_publish")
async def publish_server(server_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformMcpServer]:
    return Envelope(data=_repo(request).set_status(server_id, "published"))


@router.post("/servers/{server_id}/unpublish", summary="下架平台 MCP", description="下架后企业不能再启用或更新；已启用的企业与成员已装的不受影响。", operation_id="operation_mcp_market_unpublish")
async def unpublish_server(server_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformMcpServer]:
    return Envelope(data=_repo(request).set_status(server_id, "unpublished"))


@router.get("/pull/servers", summary="拉取已发布 MCP 目录", description="供 Manager 服务间调用，返回已发布的平台 MCP。", operation_id="operation_mcp_market_pull_list")
async def pull_published(request: Request) -> ListEnvelope[PlatformMcpServer]:
    from shared.service_token import verify_service_token
    verify_service_token(request)
    return ListEnvelope(data=_repo(request).list(status="published"))
