"""员工/专家 Pi 会话快照（04 §6.3，D5）。

快照由用户端 Agent Service 从 Manager 拉取并冻结，包含启动一个 Pi 会话所需的
员工身份、模型策略和授权能力；Manager 离线时仍可使用本地冻结快照。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .platform_provider import PricingSnapshot
from .skill import SkillSigningKeyMetadata


class ModelPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(default=None, description="Operator 发布的 Pi model id")
    provider_ref: str | None = Field(default=None, description="Operator 平台 provider 引用（04 §6.7）")
    provider_version: int | None = Field(default=None, ge=1)
    model_version: int | None = Field(default=None, ge=1)
    pricing: PricingSnapshot | None = None
    thinking_level: str | None = Field(default=None, description="思考深度：none/basic/deep")


class ExecutionPolicy(BaseModel):
    """Pi 会话执行限制，不选择或标识底层执行器。"""

    model_config = ConfigDict(extra="forbid")

    timeout_seconds: int | None = Field(default=None, description="单次 Pi 会话超时秒数（可选）")


class EmployeeExecutionSnapshot(BaseModel):
    """创建 Pi 会话前固化的员工/专家配置快照（04 §6.3）。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    version: str = Field(description="employee 配置版本")
    snapshot_version: str = Field(description="快照版本（与 Pi 会话绑定，落用户端本地库）")
    display_name: str = ""
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md）")
    model_policy: ModelPolicy = Field(default_factory=ModelPolicy)
    execution_policy: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    tools: list[str] = Field(default_factory=list, description="工具列表")
    skills: list[str] = Field(default_factory=list, description="技能引用列表")
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list, description="连接器引用列表")
    memory_policy: dict[str, Any] | None = Field(default=None, description="记忆策略（04 §6.6，mem0）。")
    skill_signing_keys: list[SkillSigningKeyMetadata] = Field(
        default_factory=list,
        description="仅用于 Agent 离线验签的公开 key metadata；不含 private key/JWT/HMAC secret",
    )
