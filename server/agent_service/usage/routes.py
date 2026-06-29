"""usage outbox 北向路由（A5 / 02 §10.1 前缀 /api/agent）。

仅暴露**本地运维/演示**端点：查看 outbox pending、手动 drain 上报。
- 不暴露原始事件、不暴露会话内容（D13）：record_* 由本地执行链（A1/Gateway 回调）内部调用，
  不开放为北向写入口；这里只读 pending（脱敏摘要）与触发 drain。
- 生产 drain 由进程周期/触发驱动；此端点供 dev/测试手动触发与观测。
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope, Page

from .service import UsageService
from .store import OutboxItem


class FlushResult(BaseModel):
    """一次 drain 的结果（观测用）。"""

    model_config = ConfigDict(extra="forbid")

    sent: int = Field(description="成功上报数")
    failed: int = Field(description="失败数（留 pending 重试）")
    batches: int = Field(description="批次数")


def build_usage_router(service: UsageService) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-usage"])

    @router.get("/usage/outbox", summary="列待发脱敏摘要（pending）",
                description="列出 outbox 中待上报的脱敏 usage/audit 摘要。仅含脱敏聚合信息，不含会话内容。",
                operation_id="agent_list_usage_outbox")
    async def list_outbox() -> ListEnvelope[OutboxItem]:
        items = service.pending()
        next_cursor = str(len(items)) if items else None
        return ListEnvelope[OutboxItem](
            data=items, page=Page(next_cursor=next_cursor, has_more=False)
        )

    @router.post("/usage/flush", summary="手动 drain outbox 上报 Manager（尽力而为）",
                 description="手动触发 outbox drain：将待发摘要上报 Manager。生产由进程周期驱动。失败留 pending 重试。",
                 operation_id="agent_flush_usage_outbox")
    async def flush() -> Envelope[FlushResult]:
        r = service.flush()
        return Envelope[FlushResult](
            data=FlushResult(sent=r.sent, failed=r.failed, batches=r.batches)
        )

    return router
