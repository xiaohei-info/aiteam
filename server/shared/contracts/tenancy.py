"""租户上下文契约（04 §6.1.1，D20/D22）。

Manager 内所有数据访问的统一入口：
    request -> shared/auth 解析 token -> TenantContext -> TenantDataSession.begin()
    -> SET LOCAL app.tenant_id -> repository 查询

铁律：任何 repository / cache / object / queue 都**只能从 TenantContext 读取 tenant_id**，
禁止接受调用方手写的 tenant 字符串（04 §6.1.3，D22）。TenantDataSession / TenantRouter /
ManagerRagService 的实现落 manager_service + shared，本文件只定上下文形状。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class TenantContext(BaseModel):
    """单请求的租户上下文。由 shared/auth 从 TokenClaims 构造，向下游只读传递。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tenant_id: str = Field(description="租户 id（UUID 字符串），RLS 主键来源")
    user_id: str
    roles: list[str] = Field(default_factory=list)
    enterprise_id: str | None = Field(default=None)
