"""成员级授权与本地投影（04 §6.2 / 03 §9.7，D12）。

- MemberGrant：Manager 租户内「专家/方案 → 授权部门/成员」映射（写端 Manager）。
  Agent sync 时只返回授权给本账号的条目；鉴权②在 Agent + Manager 两侧校验。
- LoadedExpertProjection：Agent 本地只读投影（写端 Agent）。对话路径只读本地投影，
  不每次跨端取配置；Manager 离线时凭投影继续工作；授权变更下次 sync 失效移除。

配置下发靠 Agent **主动 pull**，不靠向用户机器推送（D12）。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MemberGrant(BaseModel):
    """成员级授权映射（写端 Manager tenant data space）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    resource_type: str = Field(description="expert | solution")
    resource_id: str
    department_ids: list[str] = Field(default_factory=list, description="部门 id 列表")
    member_ids: list[str] = Field(default_factory=list, description="成员 id 列表")
    updated_at: datetime | None = Field(default=None, description="最后更新（UTC）")


class LoadedExpertProjection(BaseModel):
    """用户端本地只读投影（写端 Agent，04 §6.2）。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    tenant_id: str
    version: str = Field(description="配置版本/etag，用于增量 sync")
    display_name: str = ""
    runtime_binding: str | None = Field(default=None, description="runtime 标识符（hermes_acp/claude_code_json_stream 等）")
    synced_at: datetime | None = Field(default=None, description="最后同步时间（UTC）")
    revoked: bool = Field(default=False, description="授权撤销后置 true 并从可用列表移除")
