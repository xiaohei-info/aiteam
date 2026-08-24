"""运营端目录北向 API 边界 schema（02 §10.3，05 F03）。

仅声明本端 HTTP 请求/响应形状；跨端契约（CatalogReleaseNotify/ExpertTemplateDetail/
SolutionPackage）一律从 shared.contracts.crosstier import，**禁在此重定义**。

模板真相态归 Operator（D1 / F03）。响应体不含密码、token、provider key、会话内容。

字段对齐 PRD-v2 S02/S03。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.platform_provider import PlatformModelRef
from shared.contracts.platform_skill import PlatformSkillRef


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
    avatar_url: str = Field(default="", description="可选头像图片 URL")
    system_prompt: str = Field(min_length=1, description="岗位描述系统提示词（纯文本）(PRD: system_prompt, 必填)")
    platform_model_ref: PlatformModelRef = Field(description="Operator 已发布平台 Provider/模型固定引用")
    platform_skill_refs: list[PlatformSkillRef] = Field(default_factory=list, description="Operator 内部平台技能固定版本引用")
    skill_ids: list[str] = Field(default_factory=list, description="Deprecated compatibility field; use skill_refs")
    description: str = Field(min_length=1, max_length=200, description="用户可见职位描述（≤200字）(PRD: description, 必填)")


# ---- 行业方案（对齐 PRD-v2 S03 + 下游 apply/建群业务流程所需字段）----

class RegisterSolutionTemplateRequest(BaseModel):
    """注册行业方案模板（北向请求）。引用专家模板 + 知识/技能 refs + 协作编排规则。

    保留字段依据：Operator 设置 → Manager apply（落 solution_instance）→ Agent 从方案创建群聊
    继承编排规则（planner/subtask/aggregate_prompt 三段 prompt）。default_kb_blueprint /
    default_skill_bundle / default_collaboration_template_ref 已删除——下游无消费。
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
    planner_template_id: str = Field(
        default="",
        description="Planner 角色：必须指定方案内某一专家模板为编排者（planner）；空由服务端拒绝",
    )
    knowledge_refs: list[str] = Field(default_factory=list, description="知识集引用列表")
    skill_refs: list[str] = Field(default_factory=list, description="技能引用列表")
    default_grants: dict | None = Field(default=None, description="默认授权配置（可选）")
    planner_prompt: str = Field(
        default="", description="方案级协作编排规则：planner 阶段 prompt；必填，服务端强制非空"
    )
    subtask_prompt: str = Field(
        default="", description="方案级协作编排规则：子任务拆解 prompt"
    )
    aggregate_prompt: str = Field(
        default="", description="方案级协作编排规则：多专家结果聚合 prompt"
    )
    tags: list[str] = Field(default_factory=list, description="方案标签分类")


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
    """编辑专家模板（北向请求）。部分更新。字段对齐 PRD-v2 S02。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    category: str | None = None
    avatar_url: str | None = None
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
    planner_template_id: str | None = None
    knowledge_refs: list[str] | None = None
    skill_refs: list[str] | None = None
    default_grants: dict | None = None
    planner_prompt: str | None = None
    subtask_prompt: str | None = None
    aggregate_prompt: str | None = None
    tags: list[str] | None = None


class CatalogEntryResponse(BaseModel):
    """目录项响应（北向）。Operator 持有的模板真相态投影。"""

    model_config = ConfigDict(extra="forbid")

    catalog_type: CatalogType
    template_id: str
    version: str
    display_name: str
    status: CatalogStatus
    visible_scope: dict | None = None
    category: str = Field(default="")
    avatar_url: str = Field(default="")
    system_prompt: str = Field(default="")
    platform_model_ref: PlatformModelRef | None = None
    skill_ids: list[str] = Field(default_factory=list, description="Deprecated compatibility projection")
    platform_skill_refs: list[PlatformSkillRef] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    description: str = Field(default="")
    initial_memories: list[dict] = Field(default_factory=list)
    sort_order: int = Field(default=0)

    # payload 顶层字段（对齐前端 CatalogItem 编辑模式预填与回写）。
    expert_bindings: list["ExpertBinding"] | None = Field(
        default=None, description="方案内专家绑定列表（仅 solution_template）"
    )
    knowledge_refs: list[str] = Field(default_factory=list, description="知识库引用（仅 solution_template）")
    skill_refs: list[str] = Field(default_factory=list, description="技能引用（仅 solution_template）")
    default_grants: dict | None = Field(default=None, description="默认授权（仅 solution_template）")


# ---- 详情视图（对齐前端 CatalogItem，返回完整 payload 顶层字段）----
# 仅在北向 GET 详情 / list 接口内使用；manager-pull 仍用 CatalogEntryResponse。
class CatalogDetailView(CatalogEntryResponse):
    """单目录项详情响应（含模板 payload 全量字段）。前端多 section 渲染的来源。"""

    model_config = ConfigDict(extra="forbid")

    expert_template_ids: list[str] = Field(default_factory=list)
    planner_template_id: str = Field(default="", description="方案内被指定为 planner 的专家模板 id")
    planner_prompt: str = Field(default="")
    subtask_prompt: str = Field(default="")
    aggregate_prompt: str = Field(default="")
