"""运营端目录北向 API 边界 schema（02 §10.3，05 F03）。

仅声明本端 HTTP 请求/响应形状；跨端契约（CatalogReleaseNotify/ExpertTemplateDetail/
SolutionPackage）一律从 shared.contracts.crosstier import，**禁在此重定义**。

模板真相态归 Operator（D1 / F03）。响应体不含密码、token、provider key、会话内容。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.enums import CatalogStatus, CatalogType


class RegisterExpertTemplateRequest(BaseModel):
    """注册专家模板（北向请求）。注册即草稿态，发布前不外溢 Manager。"""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, description="模板稳定标识，租户实例据此招募")
    display_name: str = Field(min_length=1)
    persona: str | None = Field(default=None)
    recommended_config: dict = Field(default_factory=dict)


class RegisterSolutionTemplateRequest(BaseModel):
    """注册行业方案模板（北向请求）。引用专家模板 + 知识/技能 refs。"""

    model_config = ConfigDict(extra="forbid")

    solution_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    expert_template_ids: list[str] = Field(default_factory=list)
    knowledge_refs: list[str] = Field(default_factory=list)
    skill_refs: list[str] = Field(default_factory=list)
    default_grants: dict | None = Field(default=None)


class PublishTemplateRequest(BaseModel):
    """发布目录项（北向请求）。可选携带初始可见范围。"""

    model_config = ConfigDict(extra="forbid")

    visible_scope: dict | None = Field(
        default=None, description="可见范围（如 tenant_ids 白名单）；空=全可见"
    )


class SetVisibilityRequest(BaseModel):
    """变更已发布目录项的可见范围（北向请求）。"""

    model_config = ConfigDict(extra="forbid")

    visible_scope: dict = Field(description="新的可见范围")


class UpdateExpertTemplateRequest(BaseModel):
    """编辑专家模板（北向请求）。部分更新。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    persona: str | None = None
    recommended_config: dict | None = None

class UpdateSolutionTemplateRequest(BaseModel):
    """编辑行业方案模板（北向请求）。部分更新。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    expert_template_ids: list[str] | None = None
    knowledge_refs: list[str] | None = None
    skill_refs: list[str] | None = None
    default_grants: dict | None = None


class CatalogEntryResponse(BaseModel):
    """目录项响应（北向）。Operator 持有的模板真相态投影。"""

    model_config = ConfigDict(extra="forbid")

    catalog_type: CatalogType
    template_id: str
    version: str
    display_name: str
    status: CatalogStatus
    visible_scope: dict | None = None
