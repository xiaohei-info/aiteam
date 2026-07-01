"""跨系统 pull 契约骨架（05 §5.1/§5.4 + F01–F16，D4/D14）。

通信面（窄）：
- Operator ↔ Manager：云侧受控服务间调用（企业开通/负责人同步/目录/模板包/汇总）。
- Agent → Manager：用户端主动访问（登录/拉授权配置·快照/上报摘要）。用户机器无入站。

约定（05 §5.1/§5.3）：跨端走 service_client + 服务身份签名；写调用必带 `Idempotency-Key`
（HTTP header，不在 body）；只读可幂等重试；Manager 离线只影响拉新配置/新登录/上报（D14）。

本文件是**请求/响应形状骨架**，完整逐接口契约由各 service 的 Pydantic schema 生成/校验
（02 §10.3，留详设 00 §20.2）。下游不得绕过这些边界新增隐式链路（05 §6.5.2）。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

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
    initial_quota_policy: dict | None = Field(default=None, description="首次开通时默认配额策略（可选）")
    visible_catalog_policy: dict | None = Field(default=None, description="可见目录策略（可选）")


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
    visible_scope: dict | None = Field(default=None, description="可见范围定义（可选）")



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

class ExpertTemplateDetail(BaseModel):
    """F06 招募专家：Manager 向 Operator 拉专家模板详情（响应）。Operator 持模板真相，不写 Manager 库。"""

    model_config = ConfigDict(extra="forbid")

    template_id: str
    version: str
    display_name: str
    persona: str | None = None
    recommended_config: dict = Field(default_factory=dict, description="推荐配置键值对（招募时预填充）")
    default_model_json: dict = Field(default_factory=dict, description="默认模型配置（provider/model/temperature/max_tokens）；Operator 预设，Manager 招募时继承")
    default_binding_json: dict = Field(default_factory=dict, description="默认运行时绑定（skills/knowledge_bases/memory 等）；Operator 预设，Manager 招募时继承")
    prompt_pack_json: dict = Field(default_factory=dict, description="提示词包（system_prompt/behavior_rules/opening_message 等）；Operator 预设，Manager 招募时继承")
    category_code: str = Field(default="", description="专家分类码（用于目录筛选）；Operator 预设")
    role_name: str = Field(default="", description="角色名称（如技术专家、销售顾问）；Operator 预设")
    sequence_no: int = Field(default=1, ge=1, description="方案内专家绑定排序号，决定 apply 时专家的创建和编排顺序")
    enabled: bool = Field(default=True, description="单个专家启用开关；false 时方案内该专家不参与 apply")


class SolutionPackage(BaseModel):
    """F07 应用方案：Manager 向 Operator 拉行业方案包（响应）。在本 tenant 展开为 solution instance。"""

    model_config = ConfigDict(extra="forbid")

    solution_id: str
    version: str
    display_name: str
    experts: list[ExpertTemplateDetail] = Field(default_factory=list, description="模板中的专家列表")
    knowledge_refs: list[str] = Field(default_factory=list, description="知识集引用列表")
    skill_refs: list[str] = Field(default_factory=list, description="技能引用列表")
    default_grants: dict | None = Field(default=None, description="默认授权配置（可选）")
    planner_prompt: str = Field(default="", description="方案级协作编排规则：planner prompt；空=回退运行时默认")
    subtask_prompt: str = Field(default="", description="方案级协作编排规则：子任务拆解 prompt")
    aggregate_prompt: str = Field(default="", description="方案级协作编排规则：多专家结果聚合 prompt")
    default_kb_blueprint: dict = Field(default_factory=dict, description="默认知识库蓝图（apply 时下发）")
    default_skill_bundle: dict = Field(default_factory=dict, description="默认技能包（apply 时下发）")
    default_collaboration_template_ref: str | None = Field(default=None, description="默认协作模板引用（可选）")
    tags: list[str] = Field(default_factory=list, description="方案标签分类")


# ---- Agent → Manager（用户端主动访问）----

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


class UsageSummaryUpload(BaseModel):
    """F13 用量回流：Agent 上报脱敏 summary 到 Manager（按 summary_id 幂等）。不含会话内容。"""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    usage: list[UsageSummary] = Field(default_factory=list, description="脱敏 UsageSummary 列表")
    audits: list[AuditSummaryEvent] = Field(default_factory=list, description="脱敏 AuditSummaryEvent 列表")
