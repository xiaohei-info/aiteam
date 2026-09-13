"""员工/专家 Pi 会话快照（04 §6.3，D5）。

快照由用户端 Agent Service 从 Manager 拉取并冻结，包含启动一个 Pi 会话所需的
员工身份、模型策略和授权能力；Manager 离线时仍可使用本地冻结快照。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .platform_provider import PricingSnapshot
from .skill import SkillSigningKeyMetadata


class ModelPolicy(BaseModel):
    """Consumer-facing model identity and effective runtime policy.

    Provider/model release versions belong to Operator catalog history, not to
    an employee or Agent reference. Legacy keys are accepted once and dropped.
    """

    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(default=None, description="Operator 发布的 Pi model id")
    provider_ref: str | None = Field(default=None, description="Operator 平台 provider 引用（04 §6.7）")
    pricing: PricingSnapshot | None = None
    thinking_level: str | None = Field(
        default=None,
        description="思考档位：由模型能力目录决定（off/minimal/low/medium/high/xhigh/max）。",
    )

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_versions(cls, value):
        if isinstance(value, Mapping):
            value = dict(value)
            value.pop("provider_version", None)
            value.pop("model_version", None)
        return value


class ExecutionPolicy(BaseModel):
    """Pi 会话执行限制，不选择或标识底层执行器。"""

    model_config = ConfigDict(extra="forbid")

    timeout_seconds: int | None = Field(default=None, description="单次 Pi 会话超时秒数（可选）")


class KnowledgePolicySnapshot(BaseModel):
    """Effective knowledge permission; empty operations explicitly deny both tools."""

    model_config = ConfigDict(extra="forbid")
    state: Literal["inherit", "allow", "deny"] = "inherit"
    allowed_operations: list[Literal["knowledge_search", "knowledge_get"]] = Field(default_factory=list)
    revision: str = "0"


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
    skills: list[str] = Field(
        default_factory=list,
        description="规范技能引用列表；Agent 以 presence-aware 快照字段为准，显式 [] 不回退旧 skill_refs。",
    )
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    knowledge_policy: KnowledgePolicySnapshot | None = Field(default=None, description="有效知识策略；空allowed_operations明确拒绝，不回退默认。")
    connector_refs: list[str] = Field(default_factory=list, description="连接器引用列表")
    memory_policy: dict[str, Any] | None = Field(default=None, description="记忆策略（04 §6.6，mem0）。")
    department_ids: list[str] = Field(default_factory=list, description="所属部门 id 列表；空列表表示未设置。")
    avatar_url: str | None = Field(default=None, description="员工头像 URL；未配置时为 null。")
    avatar_version: int = Field(default=0, ge=0, description="头像元数据版本。")
    skill_signing_keys: list[SkillSigningKeyMetadata] = Field(
        default_factory=list,
        description="仅用于 Agent 离线验签的公开 key metadata；字段出现即优先于本地环境/缓存（包括显式空列表）；不含 private key/JWT/HMAC secret",
    )
