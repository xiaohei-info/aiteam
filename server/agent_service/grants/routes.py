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
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot

from .service import GrantsService
from shared.config import load_settings


def _read_runtime_selection() -> str | None:
    return load_settings("agent").agent_runtime


def _read_production_flag() -> bool:
    return load_settings("agent").is_production



from agent_service.readiness import ReadinessService, expert_to_dict, report_to_dict


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(description="租户 id")
    member_id: str = Field(description="成员 id")


class SyncResultBody(BaseModel):
    """一次 sync 的结果（观测/降级判定用）。ok=False 表示 Manager 不可达（已降级）。"""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="是否 sync 成功")
    upserted: int = Field(description="本次新增/更新授权数")
    revoked: int = Field(description="本次撤销授权数")
    error: str | None = Field(default=None, description="错误信息（降级时非空）")


def build_grants_router(service: GrantsService) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-grants"])
    readiness = ReadinessService(
        grants=service,
        runtime_selection=_read_runtime_selection(),
        production=_read_production_flag(),
    )

    @router.get("/grants/readiness", summary="整端 readiness：runtime + 每个已装载专家可用性",
                description="聚合部署级 runtime、每个已装载专家的 skills/knowledge/memory/provider 就绪状态；readiness 不满足时附原因。",
                operation_id="agent_readiness_report")
    async def readiness_report() -> Envelope[dict]:
        return Envelope[dict](data=report_to_dict(readiness.build_report()))

    @router.get("/grants/experts/{employee_id}/readiness", summary="单个专家 readiness",
                description="单个已装载专家的运行就绪状态（runtime/skills/knowledge/memory/provider）；不存在则 available=False。",
                operation_id="agent_readiness_expert")
    async def readiness_expert(employee_id: str) -> Envelope[dict]:
        return Envelope[dict](data=expert_to_dict(readiness.expert(employee_id)))


    @router.post("/grants/sync", summary="主动 pull Manager 授权配置落本地投影（尽力而为）",
                 description="Agent 主动从 Manager pull 授权配置变更，落本地只读投影。失败不阻断本地工作。",
                 operation_id="agent_sync_grants")
    async def sync(req: SyncRequest) -> Envelope[SyncResultBody]:
        r = service.sync(req.tenant_id, req.member_id)
        return Envelope[SyncResultBody](
            data=SyncResultBody(ok=r.ok, upserted=r.upserted, revoked=r.revoked, error=r.error)
        )

    @router.get("/grants/experts", summary="列本地可用专家投影（已授权未撤销）",
                description="列出本端已装载且未撤销的专家投影。数据来源为上一次 sync 的本地只读投影。",
                operation_id="agent_list_loaded_experts")
    async def list_experts() -> ListEnvelope[LoadedExpertProjection]:
        items = service.available_experts()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[LoadedExpertProjection](
            data=items, page=Page(next_cursor=next_cursor, has_more=False)
        )

    @router.get("/grants/solutions", summary="列本会话可绑定的方案实例（含三阶段 prompts 快照）",
                description="列出本端当前可用的方案实例投影。供【从解决方案创建群聊】前端入口使用——每个方案含 planner/subtask/aggregate 三阶段 prompt，传回 create_conversation 即可固定编排。",
                operation_id="agent_list_solution_instances")
    async def list_solution_instances() -> ListEnvelope[dict]:
        items = service.list_available_solutions()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[dict](data=items, page=Page(next_cursor=next_cursor, has_more=False))

    @router.get("/grants/snapshots", summary="列已冻结执行快照（观测）",
                description="列出本端已冻结的执行快照。快照在授权有效时冻结，授权撤销后仍可查阅。",
                operation_id="agent_list_frozen_snapshots")
    async def list_snapshots() -> ListEnvelope[EmployeeExecutionSnapshot]:
        items = service.frozen_snapshots()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[EmployeeExecutionSnapshot](
            data=items, page=Page(next_cursor=next_cursor, has_more=False)
        )

    return router
