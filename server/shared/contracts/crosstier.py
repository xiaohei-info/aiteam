"""跨系统 pull 契约（05 §5.1/§5.4 + F01–F16，D4/D14）。

通信面（窄）：
- Operator ↔ Manager：云侧受控服务间调用（企业开通/负责人同步/目录/模板包/汇总）。
- Agent → Manager：用户端主动访问（登录/拉授权配置·快照/上报摘要）。用户机器无入站。

约定（05 §5.1/§5.3）：跨端走 service_client + 服务身份签名；写调用必带 `Idempotency-Key`
（HTTP header，不在 body）；只读可幂等重试；Manager 离线只影响拉新配置/新登录/上报（D14）。

请求/响应形状在此定型并由各 service 的 Pydantic schema 生成/校验（02 §10.3）；下游不得绕过这些边界新增隐式链路（05 §6.5.2）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .expert_profile import ExpertTemplateProfile
from .platform_provider import PlatformModelRef
from .platform_skill import PlatformSkillRef
from .skill import SignedSkillPackage, SkillSigningKeyMetadata
from .snapshot import EmployeeExecutionSnapshot
from .summary import AuditSummaryEvent, UsageSummary

# ---- Operator → Manager（云侧）----

class TenantProvisionRequest(BaseModel):
    """F01 企业开通：Operator 调 Manager 创建 tenant。Manager 初始化租户数据空间/默认角色/知识空间。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    enterprise_name: str
    enterprise_code: str | None = Field(default=None, description="可读账号/slug，不参与 RLS 主键")
    initial_quota_policy: dict[str, Any] | None = Field(default=None, description="首次开通时默认配额策略（可选）")
    allowed_model_refs: list[PlatformModelRef] | None = Field(
        default=None,
        description="企业允许使用的当前 effective 平台模型身份；null=不限制，空列表=不开放模型。",
    )


class TenantStatusSync(BaseModel):
    """R5 企业生命周期同步：Operator → Manager 下发租户状态（tenant 来自路径，签名主体需与之一致）。"""

    model_config = ConfigDict(extra="forbid")

    status: Literal["active", "suspended", "banned", "closed", "deleted"]
    reason: str | None = Field(default=None, max_length=500)


class TenantPurgeRequest(BaseModel):
    """R5 保留期后清理：仅对 deleted 的租户生效；reason 只用于审计。"""

    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500, description="清理原因（仅供审计）")


class OwnerBootstrapSync(BaseModel):
    """F02 负责人 bootstrap：Operator 同步负责人初始/重置凭据给 Manager tenant。

    通过 TLS 服务间通道传输一次性明文；Manager 是 hash 单一真相源（单次 scrypt）。
    Operator 自身只持 sha256 用于本端校验，不持企业长期密码（03 §9.2）。
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    owner_phone: str
    bootstrap_secret: str = Field(description="bootstrap 一次性明文材料（TLS 服务间）；Manager 单次 scrypt hash 落库")
    must_reset: bool = Field(default=True, description="负责人首登强制重置")


class CatalogReleaseNotify(BaseModel):
    """F03 目录发布：Operator 通知 Manager 模板/方案的发布/下架/可见范围变更。"""

    model_config = ConfigDict(extra="forbid")

    catalog_type: str = Field(description="expert_template | solution_template")
    template_id: str
    version: str
    action: str = Field(description="published | unpublished | visibility_changed")
    visible_scope: dict[str, Any] | None = Field(default=None, description="可见范围定义（可选）")



class EnterpriseNotifyRequest(BaseModel):
    """F17 运营通知企业：Operator 通知 Manager 向指定企业发送运营侧消息（站内信）。

    Operator 不写 Manager 租户库——只经窄通道把消息转给 Manager，由 Manager 在租户上下文内
    落库（in_app_notification，经 TenantContext，红线 04 §6.1.1/D22）。
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(description="Manager 侧 tenant_id（RLS 主键来源，Operator 从企业账号映射得来）")
    org_id: str = Field(description="运营端企业 id（org_id），用于 Manager 侧关联展示/审计")
    message: str = Field(description="运营通知正文（平台→企业的管理消息）")
    notify_type: str = Field(default="operation_announcement", description="运营通知分类（如 announcement/maintenance/policy）")
    severity: str = Field(default="info", description="info | warning | critical")


# ---- Manager → Operator（云侧）----

class ExpertTemplateDetail(ExpertTemplateProfile):
    """F06 招募专家：Manager 向 Operator 拉专家模板详情（响应）。Operator 持模板真相，不写 Manager 库。

    字段对齐 PRD-v2 S02 + 保留 Manager apply 路径消费的 persona/recommended_config；
    人才市场展示字段（tagline/use_cases/pricing 等）继承自 ExpertTemplateProfile，全部可缺省。
    """

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_model(cls, value):
        # 专家模板不再携带模型 / 思考档位（模型由企业招募时选择）；兼容旧 Operator 的响应，读入时丢弃。
        if isinstance(value, dict):
            value = {k: v for k, v in value.items() if k != "platform_model_ref"}
        return value

    template_id: str
    version: str
    display_name: str
    persona: str | None = Field(default=None, description="内部人设/系统提示词影子（backfill from system_prompt）")
    recommended_config: dict[str, Any] = Field(
        default_factory=dict,
        description="推荐配置（Manager 招募时预填充模型和专家能力配置）；backfill from flat 字段",
    )
    category: str = Field(default="", description="分类（市场营销/财务分析/…）")
    avatar_url: str = Field(default="", description="头像图片 URL")
    system_prompt: str = Field(default="", description="岗位描述系统提示词（纯文本）")
    skill_ids: list[str] = Field(default_factory=list, description="Deprecated compatibility projection")
    platform_skill_refs: list[PlatformSkillRef] = Field(default_factory=list, description="Operator platform skill fixed references")
    description: str = Field(default="", description="用户可见职位描述（≤200字）")
    initial_memories: list[dict[str, Any]] = Field(default_factory=list, description="预置记忆条目")
    sort_order: int = Field(default=0, description="人才市场排列顺序（数值越小越靠前）")
    sequence_no: int = Field(default=1, ge=1, description="方案内专家绑定排序号，决定 apply 时专家的创建和编排顺序")
    enabled: bool = Field(default=True, description="单个专家启用开关；false 时方案内该专家不参与 apply")
    updated_at: datetime | None = Field(default=None, description="模板最近一次注册/编辑/发布时间；旧模板为 null")


class RecommendedCapability(BaseModel):
    """方案推荐的 Agent 能力（skill / MCP）。只是提示：不绑定到专家，不参与授权；
    用户端对话中确实需要时，才询问用户是否安装。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["skill", "mcp"]
    ref: str = Field(min_length=1, max_length=64, description="skill 为平台 skill_id；mcp 为连接器标识")
    display_name: str = Field(default="", max_length=80)
    purpose: str = Field(default="", max_length=200)


class HiddenExpertRef(BaseModel):
    """方案内因发布范围对本企业不可见的专家：只带名称与模板 id。"""

    model_config = ConfigDict(extra="forbid")

    template_id: str
    display_name: str = ""


class SolutionPackage(BaseModel):
    """F07 应用方案：Manager 向 Operator 拉行业方案包（响应）。在本 tenant 展开为 solution instance。

    字段对齐 PRD-v2 S03 + 下游 apply/建群业务流程。default_kb_blueprint /
    default_skill_bundle / default_collaboration_template_ref 已删除——跨端契约历史占位，下游无消费。
    """

    model_config = ConfigDict(extra="forbid")

    solution_id: str
    version: str
    display_name: str
    description: str = Field(default="", description="方案描述")
    icon: str = Field(default="", description="方案图标")
    coordinator_template_id: str = Field(default="", description="方案内固定协调专家模板 id")
    coordinator_instructions: str = Field(default="", max_length=4000, description="可选的自然语言协作说明，不定义执行状态机")
    workflow_skill_ref: dict[str, Any] | None = Field(default=None, description="可选的已发布固定版本方案工作流 Skill 引用")
    output_requirements: str = Field(default="", description="可选的方案交付要求")
    mode: Literal["solo", "group"] = Field(default="group", description="solo：单人方案（1 位专家、不建群）；group：组群方案")
    orchestration_rules: str = Field(
        default="", max_length=16000,
        description="群聊编排规则（collaboration-markdown-v1）；成员用 @{专家模板 id} 引用，Manager 应用时换成员工 ID。solo 为空",
    )
    recommended_capabilities: list[RecommendedCapability] = Field(
        default_factory=list, max_length=24, description="推荐的 skill / MCP（非强制，仅供用户端对话中提示）",
    )
    experts: list[ExpertTemplateDetail] = Field(default_factory=list, description="模板中的专家列表（按固定顺序）")
    tags: list[str] = Field(default_factory=list, description="方案标签分类")
    hidden_expert_count: int = Field(default=0, ge=0, description="方案内因发布范围对本企业不可见、未下发的专家数")
    hidden_experts: list[HiddenExpertRef] = Field(
        default_factory=list, max_length=64,
        description="不可见专家的名称与模板 id，仅用于编排规则引用到它们时告诉管理员该找运营问什么；不含专家内容",
    )


# ---- Agent → Manager（用户端主动访问）----

class CapabilityProvenance(BaseModel):
    """来自其他平台的技能 / MCP 的出处（设计 2026-11-20「技能MCP命名空间出处与更新提示」§4.1）。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["clawhub", "url", "platform"]
    label: str = Field(description="展示用出处，如「ClawHub steipete/weather」「github.com/acme/skills」「taiyim/weather」")
    url: str = Field(default="", description="出处链接（https）；没有时为空")
    version: str = Field(default="", description="改编时的上游版本")
    edited: bool = Field(default=False, description="false：原样取自该处（「来自」）；true：我们改过（「改自」）")


class InstallableSkill(BaseModel):
    """成员可在对话中自行安装的企业技能（只读摘要，不含文件内容）。"""

    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(description="企业技能目录里的 skill_id")
    display_name: str = ""
    version: str
    content_hash: str
    source_skill_id: str = Field(default="", description="来自平台技能市场时的平台 skill_id，供方案推荐清单对应")
    origin: Literal["platform", "enterprise"] = Field(
        default="enterprise",
        description="platform：从平台技能市场安装到企业目录；enterprise：企业自建。只有 platform 可使用「以后自动安装」",
    )
    name: str = Field(default="", description="SKILL.md 里的 name；成员本机同名技能只能装一个（员工只会用到第一个）")
    namespace: str = Field(default="", description="展示前缀：平台为 taiyim，企业为企业名称（未设置时企业代码）；原样取自其他平台的为空")
    provenance: CapabilityProvenance | None = Field(default=None, description="来自其他平台时的出处")


class InstallableMcpServer(BaseModel):
    """成员可自行安装的 MCP：企业从平台目录启用的，或企业自建的（设计 §11.3、2026-11-20 §4.4）。需鉴权的条目由成员在本机自行登录 / 填写令牌（设计 2026-11-18）。"""

    model_config = ConfigDict(extra="forbid")

    server_id: str = Field(description="平台 MCP ID（Operator server_id），或企业自建 MCP ID（`ent-` 前缀）")
    ref: str = Field(description="成员本机安装时使用的标识")
    display_name: str
    summary: str = ""
    url: str = Field(description="端点地址（https）；以企业目录为准，模型给出的地址被忽略")
    tools: list[str] = Field(description="声明的工具名；安装时只保留与服务端实际工具的交集")
    revision: int = Field(ge=1, description="平台条目：企业启用时的平台修订号；企业自建条目：企业修订号（每次修改加 1）")
    auth: Literal["none", "oauth", "bearer"] = Field(default="none", description="鉴权方式：none 无需；oauth 成员在服务方网页登录；bearer 成员填写服务方发的访问令牌")
    auth_header: str = Field(default="", description="bearer：携带令牌的请求头名；空表示 Authorization: Bearer")
    oauth_scopes: str = Field(default="", description="oauth：登录时申请的权限范围（空格分隔）")
    timeout_ms: int = Field(default=30000, ge=1000, le=300000, description="单次工具调用超时（毫秒）")
    oauth_client: Literal["preregistered", "dynamic"] = Field(default="dynamic", description="oauth：preregistered 平台或企业已登记应用编号（登录时经 oauth-client 接口取回）；dynamic 成员登录时自动注册")
    origin: Literal["platform", "enterprise"] = Field(
        default="platform",
        description="platform：企业从平台 MCP 目录启用；enterprise：企业自建。只有 platform 可使用「以后自动安装」",
    )
    namespace: str = Field(default="", description="展示前缀：平台为 taiyim，企业自建为企业名称（未设置时企业代码）")


class InstallableSkillPackage(BaseModel):
    """为当前成员签名的技能包与验签公钥（仅公钥材料）。"""

    model_config = ConfigDict(extra="forbid")

    package: SignedSkillPackage
    signing_keys: list[SkillSigningKeyMetadata] = Field(default_factory=list)


class AuthorizedConfigPullRequest(BaseModel):
    """F10 授权配置同步（请求）：Agent 带本地投影版本/etag，Manager 只回增量。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    member_id: str
    known_versions: dict[str, str] = Field(
        default_factory=dict, description="employee_id/solution_id -> 本地已持版本/etag"
    )


class AuthorizedConfigPullResponse(BaseModel):
    """F10 授权配置同步（响应）：Manager 按 tenant + member_grant 裁剪后的增量。"""

    model_config = ConfigDict(extra="forbid")

    experts: list[dict] = Field(default_factory=list, description="可见专家配置（投影源）")
    skill_packages: list[SignedSkillPackage] = Field(
        default_factory=list,
        description="授权给本 member 的技能包真相（增量快照，供 Agent cache 按 version/hash 更新/删除）",
    )
    skill_packages_authoritative: bool = Field(
        default=True,
        description="False 表示本次 Manager 响应不可用于撤销本地技能缓存",
    )
    skill_signing_keys: list[SkillSigningKeyMetadata] = Field(
        default_factory=list,
        description="当前/next/revoked 的公开 Ed25519 key metadata；绝不包含 private key",
    )
    solutions: list[dict] = Field(default_factory=list, description="方案实例列表")
    revoked_ids: list[str] = Field(default_factory=list, description="已撤销/不可见，需本地失效移除")


class SnapshotPullRequest(BaseModel):
    """F11 执行快照（请求）：Agent 提交 run 前向 Manager 拉快照。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    member_id: str
    employee_id: str
    employee_version: str | None = Field(default=None, description="空=取当前版本")


class SnapshotPullResponse(BaseModel):
    """F11 执行快照（响应）：Manager 生成快照；Agent 本地冻结 snapshot_version。"""

    model_config = ConfigDict(extra="forbid")

    snapshot: EmployeeExecutionSnapshot


class EnterpriseRollupUpload(BaseModel):
    """Manager → Operator sanitized usage batch (F13).

    Nested ``UsageSummary.cost_total`` is nullable: unknown pricing is carried
    as ``null`` with ``pricing_status='unknown'``, never as a numeric zero.
    """

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    summaries: list[UsageSummary] = Field(default_factory=list)


class UsageSummaryUpload(BaseModel):
    """F13 用量回流：Agent 上报脱敏 summary 到 Manager（按 summary_id 幂等）。不含会话内容。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    usage: list[UsageSummary] = Field(default_factory=list, description="脱敏 UsageSummary 列表")
    audits: list[AuditSummaryEvent] = Field(default_factory=list, description="脱敏 AuditSummaryEvent 列表")
