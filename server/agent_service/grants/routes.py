"""授权配置 / 冻结快照北向路由（A4 / 02 §10.1 前缀 /api/agent）。

仅暴露**本地运维/演示/触发**端点：
- 列本地可用专家投影（已授权未撤销，只读本地投影）。
- 手动触发 sync（dev/测试；生产由进程周期/登录后触发驱动）。
- 列已冻结快照（观测）。

红线：sync 是 Agent **主动 pull**，无任何 Manager 推送入口；本路由不提供写企业端配置的端点。
生产中 tenant_id/member_id 应从 token claims 取（骨架期同 mainline 用请求体）。
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot

from .service import GrantsService


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str
    member_id: str


class SyncResultBody(BaseModel):
    """一次 sync 的结果（观测/降级判定用）。ok=False 表示 Manager 不可达（已降级）。"""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    upserted: int
    revoked: int
    error: str | None = None


def build_grants_router(service: GrantsService) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-grants"])

    @router.post("/grants/sync", summary="主动 pull Manager 授权配置落本地投影（尽力而为）",
                 operation_id="agent_sync_grants")
    async def sync(req: SyncRequest) -> Envelope[SyncResultBody]:
        r = service.sync(req.tenant_id, req.member_id)
        return Envelope[SyncResultBody](
            data=SyncResultBody(ok=r.ok, upserted=r.upserted, revoked=r.revoked, error=r.error)
        )

    @router.get("/grants/experts", summary="列本地可用专家投影（已授权未撤销）",
                operation_id="agent_list_loaded_experts")
    async def list_experts() -> ListEnvelope[LoadedExpertProjection]:
        items = service.available_experts()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[LoadedExpertProjection](
            data=items, page=Page(next_cursor=next_cursor, has_more=False)
        )

    @router.get("/grants/snapshots", summary="列已冻结执行快照（观测）",
                operation_id="agent_list_frozen_snapshots")
    async def list_snapshots() -> ListEnvelope[EmployeeExecutionSnapshot]:
        items = service.frozen_snapshots()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[EmployeeExecutionSnapshot](
            data=items, page=Page(next_cursor=next_cursor, has_more=False)
        )

    return router
