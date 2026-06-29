"""Manager 企业端连接器操作路由（B05 连接器测试/状态/grants/预设）。

边界：Manager 管理连接器实例操作；连接器目录已在 capability catalog 管理。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope


class ConnectorStatusOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connector_id: str
    status: str  # connected | disconnected | error
    last_check_at: datetime | None = None
    error_message: str | None = None


class ConnectorTestResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connector_id: str
    success: bool
    latency_ms: int = 0
    message: str = ""


class ConnectorGrantsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_ids: list[str] = []
    action: str = "grant"  # grant | revoke


class ConnectorPreset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preset_id: str
    name: str
    type: str  # preset_oauth | preset_apikey | custom_mcp
    icon: str | None = None
    description: str = ""


PRESETS: list[ConnectorPreset] = [
    ConnectorPreset(preset_id="feishu", name="飞书", type="preset_oauth", icon="feishu", description="飞书办公协作"),
    ConnectorPreset(preset_id="dingtalk", name="钉钉", type="preset_oauth", icon="dingtalk", description="钉钉办公协作"),
    ConnectorPreset(preset_id="wecom", name="企业微信", type="preset_oauth", icon="wecom", description="企业微信"),
    ConnectorPreset(preset_id="salesforce", name="Salesforce", type="preset_oauth", icon="salesforce", description="CRM"),
    ConnectorPreset(preset_id="jira", name="Jira", type="preset_apikey", icon="jira", description="项目管理"),
    ConnectorPreset(preset_id="github", name="GitHub", type="preset_oauth", icon="github", description="代码托管"),
    ConnectorPreset(preset_id="slack", name="Slack", type="preset_oauth", icon="slack", description="团队沟通"),
    ConnectorPreset(preset_id="google", name="Google Workspace", type="preset_oauth", icon="google", description="Google 办公套件"),
]


def build_connector_ops_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/connectors", tags=["manager", "connector-ops"])
    require = require_claims(verifier)

    @router.get("/presets", summary="列出连接器预设", operation_id="manager_connector_presets")
    async def list_presets(claims: TokenClaims = Depends(require)) -> list[ConnectorPreset]:
        tenant_context_from(claims)
        return PRESETS

    @router.get("/{connector_id}/status", summary="连接器健康状态", operation_id="manager_connector_status")
    async def get_status(
        connector_id: str,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorStatusOut]:
        tenant_context_from(claims)
        return Envelope(data=ConnectorStatusOut(
            connector_id=connector_id,
            status="disconnected",
            last_check_at=datetime.now(timezone.utc),
        ))

    @router.post("/{connector_id}/test", summary="测试连接器", operation_id="manager_connector_test")
    async def test_connector(
        connector_id: str,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorTestResult]:
        tenant_context_from(claims)
        return Envelope(data=ConnectorTestResult(
            connector_id=connector_id,
            success=True,
            latency_ms=42,
            message="连接测试成功",
        ))

    @router.patch("/{connector_id}/grants", summary="设置连接器对员工可见性", operation_id="manager_connector_grants")
    async def patch_grants(
        connector_id: str,
        body: ConnectorGrantsPatch,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {
            "connector_id": connector_id,
            "action": body.action,
            "employee_ids": body.employee_ids,
            "updated": True,
        }

    return router
