"""employee 独立绑定实体 北向 schema（issue AITEAM-234 / GitHub AITEAM-280，02 §10）。

runtime 中立（D16/D17）：只搬运中立字段，不出现 runtime 原生格式（SOUL.md/config.yaml/启动参数）。
全部输出模型 extra="forbid"（02 §10.3 契约防腐）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool


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
    config: dict[str, Any] = Field(default_factory=dict, description="级联覆盖参数。")


class SkillBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    config: dict[str, Any] | None = None


class SkillBindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    skill_id: str
    enabled: bool
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


# ---------------- Knowledge Bindings ----------------

class KnowledgeBindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [
        {
            "knowledge_space_id": "enterprise_shared",
            "enabled": True,
            "config": {"source": "synthetic-fixture"},
        }
    ]})
    knowledge_space_id: str = Field(description="绑定的 knowledge_space id")
    enabled: bool = True
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="级联覆盖参数；仅允许有界非敏感 JSON 配置。",
    )


class KnowledgeBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [
        {"enabled": True, "config": {"source": "synthetic-fixture"}},
        {"enabled": False, "config": {"source": "synthetic-fixture"}},
    ]})
    enabled: bool | None = None
    config: dict[str, Any] | None = None


class KnowledgePolicyMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy_revision: int = 0
    policy_source: str = "legacy_observed"
    policy_actor: str | None = None
    policy_updated_at: datetime | None = None
    revoked_at: datetime | None = None


class KnowledgeDocumentBindingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


class KnowledgeDocumentBindingOut(KnowledgePolicyMetadata):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [
        {"employee_id": "00000000-0000-4000-8000-000000000001", "document_id": "00000000-0000-4000-8000-000000000002", "enabled": True, "status": "ready", "policy_revision": 2, "policy_source": "admin", "policy_actor": "00000000-0000-4000-8000-000000000003", "policy_updated_at": "2026-09-01T08:00:00Z", "revoked_at": None},
        {"employee_id": "00000000-0000-4000-8000-000000000001", "document_id": "00000000-0000-4000-8000-000000000002", "enabled": False, "status": "ready", "policy_revision": 3, "policy_source": "admin", "policy_actor": "00000000-0000-4000-8000-000000000003", "policy_updated_at": "2026-09-01T09:00:00Z", "revoked_at": "2026-09-01T08:00:00Z"},
    ]})
    employee_id: str
    document_id: str
    enabled: bool | None = Field(default=None, description="NULL=inherit; false=explicit deny independent of index status.")
    status: str = Field(description="Index state, not administrator permission.")


class KnowledgeBindingOut(KnowledgePolicyMetadata):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [
        {"binding_id": "00000000-0000-4000-8000-000000000004", "employee_id": "00000000-0000-4000-8000-000000000001", "knowledge_space_id": "enterprise_shared", "enabled": True, "config": {"source": "manager-fixture"}, "created_at": "2026-09-01T08:00:00Z", "updated_at": "2026-09-01T08:00:00Z", "policy_revision": 2, "policy_source": "admin", "policy_actor": "00000000-0000-4000-8000-000000000003", "policy_updated_at": "2026-09-01T08:00:00Z", "revoked_at": None},
        {"binding_id": "00000000-0000-4000-8000-000000000004", "employee_id": "00000000-0000-4000-8000-000000000001", "knowledge_space_id": "enterprise_shared", "enabled": False, "config": {"source": "manager-fixture"}, "created_at": "2026-09-01T08:00:00Z", "updated_at": "2026-09-01T08:00:00Z", "policy_revision": 3, "policy_source": "admin", "policy_actor": "00000000-0000-4000-8000-000000000003", "policy_updated_at": "2026-09-01T09:00:00Z", "revoked_at": "2026-09-01T08:00:00Z"},
    ]})
    binding_id: str
    employee_id: str
    knowledge_space_id: str
    enabled: bool
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime


# ---------------- Memory Setting (1:1) ----------------

class MemorySettingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy: dict[str, Any] = Field(default_factory=dict, description="有效Hindsight策略；显式[]拒绝全部操作，自动提炼须explicit_auto_retain=true。")
    seed_memories: list[dict[str, Any]] = Field(default_factory=list, description="种子记忆。")
    retention_days: int | None = Field(default=None, ge=1, le=36500, description="有限保留期未通过原生验证时能力503；null为无期限。")
    scope: str = Field(default="employee", pattern="^employee$", description="仅employee-private bank。")


class MemorySettingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    policy: dict[str, Any]
    seed_memories: list[dict[str, Any]]
    retention_days: int | None = None
    scope: str = "employee"
    updated_at: datetime
    revision: int = 0
    source: str = "legacy_pending"
    explicit_auto_retain: bool = False
    retention_status: str = "unlimited"
    retention_guarded: bool = False
    provenance: dict[str, Any] = Field(default_factory=dict)


# ---------------- Connector Bindings ----------------

class ConnectorBindingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connector_id: str = Field(description="绑定的 connector_catalog.connector_id")
    grant_ref: str | None = Field(default=None, description="M5 provider_credential 授权引用")
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict, description="级联覆盖参数。")


class ConnectorBindingPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    grant_ref: str | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None


class ConnectorBindingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    binding_id: str
    employee_id: str
    connector_id: str
    grant_ref: str | None = None
    enabled: bool
    config: dict[str, Any]
    created_at: datetime
    updated_at: datetime
