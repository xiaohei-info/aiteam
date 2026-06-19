"""员工/专家执行快照（04 §6.3，D5）。

所有权裁决（D5）：快照由**用户端 Agent Service 在装载专家/提交 run 时从 Manager 拉取并冻结**，
连同 snapshot_version 落用户端本地库；run 全程只引用该快照，保证一次 run 配置稳定、
Manager 离线时仍可执行。Manager 只提供「按 employee_id+version 生成快照」的接口。

RunSpec（06 §7.5.1）由本快照派生。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ModelPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(default=None, description="中立 model id；空=runtime 默认")
    provider_ref: str | None = Field(default=None, description="provider 配置引用（04 §6.7）")
    thinking_level: str | None = Field(default=None)


class RuntimePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtime_binding: str | None = Field(default=None, description="employee 默认 runtime（06 §7.6）")
    timeout_seconds: int | None = Field(default=None)


class EmployeeExecutionSnapshot(BaseModel):
    """执行前固化的员工/专家执行快照（04 §6.3）。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    version: str = Field(description="employee 配置版本")
    snapshot_version: str = Field(description="快照版本（与 run 绑定，落用户端本地库）")
    display_name: str = ""
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md）")
    model_policy: ModelPolicy = Field(default_factory=ModelPolicy)
    runtime_policy: RuntimePolicy = Field(default_factory=RuntimePolicy)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list)
    memory_policy: dict | None = Field(default=None, description="记忆策略（04 §6.6，mem0）")
