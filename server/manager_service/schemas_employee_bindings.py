"""employee 独立绑定实体 北向 schema（issue AITEAM-234 / GitHub AITEAM-280，02 §10）。

runtime 中立（D16/D17）：只搬运中立字段，不出现 runtime 原生格式（SOUL.md/config.yaml/启动参数）。
全部输出模型 extra="forbid"（02 §10.3 契约防腐）。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------------- Prompt Versions ----------------

class PromptVersionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str = Field(default="", description="版本显示名")
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md，D16）")
    model: str | None = None
    provider_ref: str | None = None
    thinking_level: str | None = None
    tools: list[str] = Field(default_factory=list, description="工具引用；A 类能力本地经 MCP 注入")
    set_current: bool = Field(default=False, description="是否立即设为当前生效版")
    change_note: str | None = Field(default=None, description="版本变更说明")


class PromptVersionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    version: int
    display_name: str
    persona: str | None = None
    model: str | None = None
    provider_ref: str | None = None
    thinking_level: str | None = None
    tools: list[str] = Field(default_factory=list)
    is_current: bool = False
    change_note: str | None = None
    created_at: datetime


# ---------------- Skill Bindings ----------------

class SkillBindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="绑定的 skill_catalog.skill_id")
    enabled: bool = True
    config: dict = Field(default_factory=dict, description="级联覆盖参数")


class SkillBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    config: dict | None = None


class SkillBindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    skill_id: str
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime


# ---------------- Knowledge Bindings ----------------

class KnowledgeBindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    knowledge_space_id: str = Field(description="绑定的 knowledge_space id")
    enabled: bool = True
    config: dict = Field(default_factory=dict, description="级联覆盖参数")


class KnowledgeBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    config: dict | None = None


class KnowledgeBindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    knowledge_space_id: str
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime


# ---------------- Memory Setting (1:1) ----------------

class MemorySettingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy: dict = Field(default_factory=dict, description="记忆策略（04 §6.6，mem0）")
    seed_memories: list = Field(default_factory=list, description="种子记忆")
    retention_days: int | None = Field(default=None, description="保留天数")
    scope: str = Field(default="tenant", description="可见性作用域（tenant/department/employee）")


class MemorySettingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    policy: dict
    seed_memories: list
    retention_days: int | None = None
    scope: str = "tenant"
    updated_at: datetime


# ---------------- Connector Bindings ----------------

class ConnectorBindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connector_id: str = Field(description="绑定的 connector_catalog.connector_id")
    grant_ref: str | None = Field(default=None, description="M5 provider_credential 授权引用")
    enabled: bool = True
    config: dict = Field(default_factory=dict, description="级联覆盖参数")


class ConnectorBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    grant_ref: str | None = None
    enabled: bool | None = None
    config: dict | None = None


class ConnectorBindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    connector_id: str
    grant_ref: str | None = None
    enabled: bool
    config: dict
    created_at: datetime
    updated_at: datetime
