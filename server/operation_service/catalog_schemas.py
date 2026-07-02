"""运营端目录北向 API 边界 schema（02 §10.3，05 F03）。

仅声明本端 HTTP 请求/响应形状；跨端契约（CatalogReleaseNotify/ExpertTemplateDetail/
SolutionPackage）一律从 shared.contracts.crosstier import，**禁在此重定义**。

模板真相态归 Operator（D1 / F03）。响应体不含密码、token、provider key、会话内容。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.enums import CatalogStatus, CatalogType


class ExpertBinding(BaseModel):
    """方案内单个专家的绑定元信息：排序号（sequence_no）与启用开关（enabled）。

    与下游 Manager SolutionTemplateBinding 实体对齐（02 §10.3），apply 时按此顺序创建和编排专家。
    """

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1)
    sequence_no: int = Field(default=1, ge=1, description="排序号，决定 apply 时专家的创建和编排顺序")
    enabled: bool = Field(default=True, description="单个专家启用开关")


class RegisterExpertTemplateRequest(BaseModel):
    """注册专家模板（北向请求）。注册即草稿态，发布前不外溢 Manager。"""

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(min_length=1, description="模板稳定标识，租户实例据此招募")
    display_name: str = Field(min_length=1)
    persona: str | None = Field(default=None)
    recommended_config: dict = Field(default_factory=dict)
    default_model_json: dict = Field(default_factory=dict, description="默认模型配置（provider/model/temperature/max_tokens）")
    default_binding_json: dict = Field(default_factory=dict, description="默认运行时绑定（skills/knowledge_bases/memory 等）")
    prompt_pack_json: dict = Field(default_factory=dict, description="提示词包（system_prompt/behavior_rules/opening_message 等）")
    category_code: str = Field(default="", description="专家分类码（用于目录筛选）")
    role_name: str = Field(default="", description="角色名称（如技术专家、销售顾问）")


class RegisterSolutionTemplateRequest(BaseModel):
    """注册行业方案模板（北向请求）。引用专家模板 + 知识/技能 refs。"""

    model_config = ConfigDict(extra="forbid")

    solution_id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    expert_template_ids: list[str] = Field(default_factory=list)
    expert_bindings: list["ExpertBinding"] = Field(
        default_factory=list,
        description="方案内专家绑定列表（含排序号与启用开关）；提供时优先于 expert_template_ids",
    )
    knowledge_refs: list[str] = Field(default_factory=list)
    skill_refs: list[str] = Field(default_factory=list)
    default_grants: dict | None = Field(default=None)
    planner_prompt: str = Field(
        default="", description="方案级协作编排规则：planner 阶段 prompt；空=回退运行时内置默认模板"
    )
    subtask_prompt: str = Field(
        default="", description="方案级协作编排规则：子任务拆解 prompt"
    )
    aggregate_prompt: str = Field(
        default="", description="方案级协作编排规则：多专家结果聚合 prompt"
    )
    default_kb_blueprint: dict = Field(default_factory=dict, description="默认知识库蓝图（apply 时下发）")
    default_skill_bundle: dict = Field(default_factory=dict, description="默认技能包（apply 时下发）")
    default_collaboration_template_ref: str | None = Field(
        default=None, description="默认协作模板引用（可选）"
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
    """编辑专家模板（北向请求）。部分更新。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    persona: str | None = None
    recommended_config: dict | None = None
    default_model_json: dict | None = None
    default_binding_json: dict | None = None
    prompt_pack_json: dict | None = None
    category_code: str | None = None
    role_name: str | None = None


class UpdateSolutionTemplateRequest(BaseModel):
    """编辑行业方案模板（北向请求）。部分更新。"""
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None
    expert_template_ids: list[str] | None = None
    expert_bindings: list["ExpertBinding"] | None = None
    knowledge_refs: list[str] | None = None
    skill_refs: list[str] | None = None
    default_grants: dict | None = None
    planner_prompt: str | None = None
    subtask_prompt: str | None = None
    aggregate_prompt: str | None = None
    default_kb_blueprint: dict | None = None
    default_skill_bundle: dict | None = None
    default_collaboration_template_ref: str | None = None
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
    default_model_json: dict = Field(default_factory=dict)
    default_binding_json: dict = Field(default_factory=dict)
    prompt_pack_json: dict = Field(default_factory=dict)
    category_code: str = Field(default="")
    role_name: str = Field(default="")

    # payload 顶层字段（对齐前端 CatalogItem 编辑模式预填与回写）。
    persona: str | None = Field(default=None, description="专家人设（仅 expert_template）")
    recommended_config: dict = Field(default_factory=dict, description="推荐配置（仅 expert_template）")
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
    planner_prompt: str = Field(default="")
    subtask_prompt: str = Field(default="")
    aggregate_prompt: str = Field(default="")
    default_kb_blueprint: dict = Field(default_factory=dict)
    default_skill_bundle: dict = Field(default_factory=dict)
    default_collaboration_template_ref: str | None = Field(default=None)
    tags: list[str] = Field(default_factory=list)
