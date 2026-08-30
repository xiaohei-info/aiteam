"""运营端目录北向 API 边界 schema（02 §10.3，05 F03）。

仅声明本端 HTTP 请求/响应形状；跨端契约（CatalogReleaseNotify/ExpertTemplateDetail/
SolutionPackage）一律从 shared.contracts.crosstier import，**禁在此重定义**。

模板真相态归 Operator（D1 / F03）。响应体不含密码、token、provider key、会话内容。

字段对齐 PRD-v2 S02/S03。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.platform_provider import PlatformModelRef
from shared.contracts.platform_skill import PlatformSkillRef

from .catalog_avatar import AVATAR_MAX_DATA_URL_LENGTH, validate_avatar_value


class ExpertBinding(BaseModel):
    """方案内单个专家的绑定元信息：排序号（sequence_no）与启用开关（enabled）。

    与下游 Manager SolutionTemplateBinding 实体对齐（02 §10.3），apply 时按此顺序创建和编排专家。
    """

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1)
    sequence_no: int = Field(default=1, ge=1, description="排序号，决定 apply 时专家的创建和编排顺序")
    enabled: bool = Field(default=True, description="单个专家启用开关")


# ---- 专家模板（对齐 PRD-v2 S02 专家模板字段规范）----

class RegisterExpertTemplateRequest(BaseModel):
    """注册专家模板（北向请求）。注册即草稿态，发布前不外溢 Manager。

    字段对齐 PRD-v2 S02：name->display_name / category / avatar_url / system_prompt /
    platform_model_ref / platform_skill_refs / description。
    创建专家模板的最小字段：名称、分类、系统提示词、默认模型、岗位描述；头像可选。
    ``avatar_url`` 保留为 Catalog 兼容字段；新头像必须是经过校验的本地图片 data URL，
    旧 HTTP/path 值仅为兼容历史 API 数据。
    技能只接受 Operator 内部平台技能的固定版本引用，未选择时为空。
    """

    model_config = ConfigDict(extra="forbid")

    template_id: str | None = Field(
        default=None,
        min_length=1,
        description="模板稳定标识。服务端按 display_name 自动生成（slug + 随机后缀）；调用方可显式指定。",
    )
    # is_published 不在注册请求中；注册即草稿，发布由单独发布动作完成（05 F03）。
    display_name: str = Field(min_length=1, description="专家名称（PRD: name）")
    category: str = Field(min_length=1, description="分类（市场营销/财务分析/…）(PRD: category, 必填)")
    avatar_url: str = Field(
        default="",
        max_length=AVATAR_MAX_DATA_URL_LENGTH,
        description="可选本地头像图片 data URL；兼容历史 HTTP/path 值，不接受其他 URI scheme",
    )
    system_prompt: str = Field(min_length=1, description="岗位描述系统提示词（纯文本）(PRD: system_prompt, 必填)")

    @field_validator("avatar_url")
    @classmethod
    def validate_avatar(cls, value: str) -> str:
        return validate_avatar_value(value)
    platform_model_ref: PlatformModelRef = Field(description="Operator 已发布平台 Provider/模型固定引用")
    platform_skill_refs: list[PlatformSkillRef] = Field(default_factory=list, description="Operator 内部平台技能固定版本引用")
    skill_ids: list[str] = Field(default_factory=list, description="Deprecated compatibility projection; use platform_skill_refs")
    description: str = Field(min_length=1, max_length=200, description="用户可见职位描述（≤200字）(PRD: description, 必填)")


# ---- 行业方案（对齐 PRD-v2 S03 + 下游 apply/建群业务流程所需字段）----

class RegisterSolutionTemplateRequest(BaseModel):
    """注册行业方案模板（北向请求）。方案只定义专家团队与协调专家。

    专家自身的知识、技能、模型和工具配置归专家模板；企业成员/部门授权与租户知识绑定
    在 Manager 应用方案时完成，不在 Operator 模板中填写跨租户引用。
    """

    model_config = ConfigDict(extra="forbid")

    solution_id: str | None = Field(
        default=None,
        min_length=1,
        description="方案稳定标识。服务端按 display_name 自动生成（slug + 随机后缀）；调用方可显式指定。",
    )
    display_name: str = Field(min_length=1, description="方案名称")
    description: str = Field(min_length=1, description="方案描述 (PRD: description, 必填)")
    icon: str = Field(default="", description="方案图标 (PRD: icon)")
    expert_template_ids: list[str] = Field(
        min_length=1, default_factory=list, description="包含的专家模板 ID 列表 (必填)"
    )
    expert_bindings: list["ExpertBinding"] = Field(
        default_factory=list,
        description="方案内专家绑定列表（含排序号与启用开关）；提供时优先于 expert_template_ids",
    )
    coordinator_template_id: str = Field(
        default="",
        description="协调专家：必须指定方案内某一专家模板；应用到 Manager 后映射为 coordinator_employee_id",
    )
    coordinator_instructions: str = Field(
        default="", max_length=4000, description="可选的自然语言协作说明，不是执行状态机或安全策略",
    )
    tags: list[str] = Field(default_factory=list, description="方案标签分类")


class PublishTemplateRequest(BaseModel):
    """发布目录项（北向请求）。可选携带初始可见范围。"""

    model_config = ConfigDict(extra="forbid")

    visible_scope: dict[str, Any] | None = Field(
        default=None, description="可见范围（如 tenant_ids 白名单）；空=全可见。"
    )


class SetVisibilityRequest(BaseModel):
    """变更已发布目录项的可见范围（北向请求）。"""

    model_config = ConfigDict(extra="forbid")

    visible_scope: dict[str, Any] = Field(description="新的可见范围配置。")


class UpdateExpertTemplateRequest(BaseModel):
    """编辑专家模板（北向请求）。部分更新。字段对齐 PRD-v2 S02。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    category: str | None = None
    avatar_url: str | None = Field(default=None, max_length=AVATAR_MAX_DATA_URL_LENGTH)

    @field_validator("avatar_url")
    @classmethod
    def validate_avatar(cls, value: str | None) -> str | None:
        return None if value is None else validate_avatar_value(value)
    system_prompt: str | None = None
    platform_model_ref: PlatformModelRef | None = None
    platform_skill_refs: list[PlatformSkillRef] | None = None
    skill_ids: list[str] | None = None
    description: str | None = None


class UpdateSolutionTemplateRequest(BaseModel):
    """编辑行业方案模板（北向请求）。部分更新。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    description: str | None = None
    icon: str | None = None
    expert_template_ids: list[str] | None = None
    expert_bindings: list["ExpertBinding"] | None = None
    coordinator_template_id: str | None = None
    coordinator_instructions: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = None


class CatalogEntryResponse(BaseModel):
    """目录项响应（北向）。Operator 持有的模板真相态投影。"""

    model_config = ConfigDict(extra="forbid")

    catalog_type: CatalogType
    template_id: str
    version: str
    display_name: str
    status: CatalogStatus
    visible_scope: dict[str, Any] | None = Field(default=None, description="目录可见范围配置。")
    category: str = Field(default="")
    avatar_url: str = Field(
        default="",
        description="经校验的本地头像图片 data URL；兼容历史 HTTP/path 值",
    )
    system_prompt: str = Field(default="")
    platform_model_ref: PlatformModelRef | None = None
    skill_ids: list[str] = Field(default_factory=list, description="Deprecated compatibility projection")
    platform_skill_refs: list[PlatformSkillRef] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    description: str = Field(default="")
    initial_memories: list[dict[str, Any]] = Field(default_factory=list, description="模板预置记忆条目。")
    sort_order: int = Field(default=0)

    # payload 顶层字段（对齐前端 CatalogItem 编辑模式预填与回写）。
    expert_bindings: list["ExpertBinding"] | None = Field(
        default=None, description="方案内专家绑定列表（仅 solution_template）"
    )
    coordinator_template_id: str = Field(default="", description="方案内被指定为协调专家的模板 id")
    coordinator_instructions: str = Field(default="", max_length=4000)


# ---- 详情视图（对齐前端 CatalogItem，返回完整 payload 顶层字段）----
# 仅在北向 GET 详情 / list 接口内使用；manager-pull 仍用 CatalogEntryResponse。
class CatalogDetailView(CatalogEntryResponse):
    """单目录项详情响应（含模板 payload 全量字段）。前端多 section 渲染的来源。"""

    model_config = ConfigDict(extra="forbid")

    expert_template_ids: list[str] = Field(default_factory=list)
    coordinator_template_id: str = Field(default="", description="方案内被指定为协调专家的模板 id")
    coordinator_instructions: str = Field(default="", max_length=4000)
