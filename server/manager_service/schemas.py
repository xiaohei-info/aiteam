"""企业端业务 API 边界 schema。

- employee/expert 配置（04 §6.1，D16）：所有配置字段都是 Pi 会话中立策略。
  本文件只 import 共享契约的 ModelPolicy / ExecutionPolicy（snapshot.py），不重定义；API 入参/出参
  以此为中立载体，不包含底层执行器或 CLI 配置。
- 成员/部门/角色 + member_grant 授权（issue #35；03 §9.7；04 §6.1，D12）：
  角色经 shared.contracts.enums.EnterpriseRole 枚举定义取值（禁用旧 admin/manager/viewer）；
  部门/成员/授权租户作用域 CRUD，tenant_id 全程经 TenantContext（D22），不接受手写过滤；
  授权映射对齐 shared.contracts.grants.MemberGrant（只 import、禁重定义）。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import ExecutionPolicy, ModelPolicy

# resource_type 取值（对齐 MemberGrant 契约）。
RESOURCE_TYPES = ("expert", "solution")


# ---- employee/expert 配置载体：复用 Pi 模型/执行策略，外加 persona 与能力引用 ----

class EmployeeConfig(BaseModel):
    """employee 的中立运行配置真相（runtime 无关）。

    本结构即 M7 EmployeeExecutionSnapshot 的配置来源（去掉 version/snapshot_version 等快照字段）。
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str = ""
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md，D16）")
    model_policy: ModelPolicy = Field(default_factory=ModelPolicy)
    execution_policy: ExecutionPolicy = Field(default_factory=ExecutionPolicy)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list, description="技能引用；A 类能力本地经 MCP 注入")
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list)
    memory_policy: dict | None = Field(default=None, description="记忆策略（04 §6.6，mem0）")


class EmployeeConfigIn(EmployeeConfig):
    """写入请求体。继承 EmployeeConfig 全部中立字段。"""



class EmployeeConfigOut(EmployeeConfig):
    """读取响应体。带 employee 身份、版本与生命周期状态（供增量 sync / 快照冻结 / 运行前检查）。"""

    employee_id: str
    employee_slug: str
    version: int = Field(description="配置版本；每次配置变更单调递增")
    status: str = Field(description="employee 主状态（EmployeeStatus 枚举值：draft/provisioning/active/paused/provisioning_failed/archived）")
    archive_reason: str | None = Field(default=None, description="仅 archived 状态存在：归档原因")
    archived_at: datetime | None = Field(default=None, description="仅 archived 状态存在：归档时间（UTC）")


# ---- 成员/部门/角色 + member_grant 授权（issue #35；03 §9.7；04 §6.1，D12）----


class DepartmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_slug: str = Field(description="租户内部门 slug，唯一约束 (tenant_id, slug)")
    display_name: str = ""


class DepartmentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str


class DepartmentOut(BaseModel):
    """部门（Manager 租户作用域）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    department_slug: str
    display_name: str
    created_at: datetime | None = None


class MemberCreate(BaseModel):
    """负责人/管理员在租户内建成员账号（03 §9.4B）。"""

    model_config = ConfigDict(extra="forbid")

    account: str = Field(description="手机号（auth_identity.external_id，provider=password）")
    initial_password: str
    display_name: str = ""
    roles: list[EnterpriseRole] = Field(
        default_factory=lambda: [EnterpriseRole.MEMBER],
        description="成员角色（EnterpriseRole 枚举；禁用旧 admin/manager/viewer）",
    )
    department_ids: list[str] = Field(default_factory=list, description="所属部门 id 列表")
    must_reset: bool = Field(
        default=True,
        description="首登是否强制重置密码（默认 True，对齐 owner 行为；False 适用于信任场景）",
    )


class MemberUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    roles: list[EnterpriseRole] | None = None
    department_ids: list[str] | None = None
    status: str | None = Field(default=None, description="active | disabled")


class MemberOut(BaseModel):
    """成员（app_user principal，租户作用域）。不回显凭据/secret。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    display_name: str
    status: str
    roles: list[str] = Field(default_factory=list, description="EnterpriseRole 取值字符串")
    department_ids: list[str] = Field(default_factory=list)


class MemberGrantCreate(BaseModel):
    """创建/替换某资源的成员级授权（D12）。"""

    model_config = ConfigDict(extra="forbid")

    resource_type: Literal["expert", "solution"] = Field(description="expert | solution")
    resource_id: str
    department_ids: list[str] = Field(default_factory=list)
    member_ids: list[str] = Field(default_factory=list)


class MemberGrantUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_ids: list[str] = Field(default_factory=list)
    member_ids: list[str] = Field(default_factory=list)


class MemberGrantOut(BaseModel):
    """成员级授权（对齐 shared.contracts.grants.MemberGrant 形状，禁重定义契约）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    resource_type: str
    resource_id: str
    department_ids: list[str] = Field(default_factory=list)
    member_ids: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None


# ---- 知识空间/RAG 管理面（M3，04 §6.1.2/§6.6；05 F08；D21）----
# workspace 只由 ManagerRagService.derive_workspace(tenant_id, knowledge_space_id) 推导（D21），
# 禁前端/Agent 直传。出参 workspace 仅展示派生结果（审计/调试），**不接受** workspace 入参。


class KnowledgeSpaceCreate(BaseModel):
    """建知识空间请求体（复用 rag_workspace 表）。"""

    model_config = ConfigDict(extra="forbid")

    knowledge_space_id: str = Field(
        description="租户内知识空间 id；workspace = derive(tenant_id, knowledge_space_id)（D21）"
    )
    display_name: str = ""


class KnowledgeSpaceUpdate(BaseModel):
    """改知识空间展示名。workspace 派生后不可改（D21：身份由 tenant+space 决定）。"""

    model_config = ConfigDict(extra="forbid")

    display_name: str


class KnowledgeSpaceOut(BaseModel):
    """知识空间出参。workspace 为派生结果（仅供审计/调试展示，不回灌入参，D21）。"""

    model_config = ConfigDict(extra="forbid")

    knowledge_space_id: str
    workspace: str = Field(description="派生 workspace（ManagerRagService 从 ctx 推导，D21）")
    display_name: str
    created_at: datetime | None = None


class KnowledgeSpaceBindingCreate(BaseModel):
    """绑定知识空间到 专家 / 部门 / 成员（仅绑定元数据，不做检索执行，D21）。"""

    model_config = ConfigDict(extra="forbid")

    knowledge_space_id: str
    resource_type: Literal["expert", "department", "member"] = Field(
        description="expert 真相态走 employee_knowledge_binding；department/member 走 knowledge_space_binding 表"
    )
    resource_id: str


class KnowledgeSpaceBindingOut(BaseModel):
    """知识空间绑定出参。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    knowledge_space_id: str
    resource_type: str
    resource_id: str
    created_at: datetime | None = None

# ---- 知识文档 intake 生命周期 + 索引绑定（issue #416；04 §6.1.2/§6.6；D21/D22）----
# 文档挂到 knowledge_space 下；状态机 uploaded → parsing → indexing → ready | failed。
# 索引绑定完成态走 knowledge_document_binding（employee ↔ document）。

KnowledgeDocumentSource = Literal["file", "url"]
KnowledgeDocumentStatus = Literal[
    "uploaded", "parsing", "indexing", "ready", "failed",
    "reindex_requested", "deleting", "deleted",
]
IngestionJobStatus = Literal["parsing", "indexing", "done", "failed", "reindex_requested"]
IndexBindingStatus = Literal["pending", "ready", "stale", "revoked"]
KnowledgeOperationKind = Literal["delete", "reindex"]
KnowledgeOperationStatus = Literal["pending", "accepted", "failed", "completed"]


class KnowledgeDocumentCreate(BaseModel):
    """上传/新建文档请求体（multipart 上传走路由层，本 schema 用于 JSON 元数据）。"""

    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(min_length=1, description="文档展示名")
    source_type: KnowledgeDocumentSource = Field(description="file=上传；url=URL 导入")


class KnowledgeDocumentOut(BaseModel):
    """文档出参（含 intake 状态）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    knowledge_space_id: str
    display_name: str
    source_type: KnowledgeDocumentSource
    file_name: str
    file_type: str
    file_size: int
    storage_key: str
    status: KnowledgeDocumentStatus
    text_chars: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class KnowledgeIngestionJobOut(BaseModel):
    """intake 任务出参。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    status: IngestionJobStatus
    error_code: str | None = None
    error_message: str | None = None
    chunk_count: int | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime | None = None


class KnowledgeDocumentBindingOut(BaseModel):
    """文档 ↔ 员工 索引绑定出参。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    employee_id: str
    rag_document_id: str | None = None
    status: IndexBindingStatus
    last_synced_at: datetime | None = None
    created_at: datetime | None = None


class KnowledgeDocumentImportUrl(BaseModel):
    """URL 导入请求体。"""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, description="http(s) URL")
    display_name: str | None = None


class KnowledgeDocumentOperationOut(BaseModel):
    """delete/reindex durable receipt，供 Manager UI 轮询/重试。"""

    model_config = ConfigDict(extra="forbid")

    operation_id: str
    operation: KnowledgeOperationKind
    idempotency_key: str
    tenant_id: str
    knowledge_space_id: str
    document_id: str
    status: KnowledgeOperationStatus
    document_status: KnowledgeDocumentStatus
    upstream_status: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None

# ---- 技能/连接器/记忆策略 目录（issue #38；04 §6.6，D17，D16/D22）----
# 三者均 tenant 作用域、runtime 中立（D16）：只存管理面真相（目录/可见性/安装绑定策略/凭据授权元数据），
# 执行态（技能本地执行、连接器对外调用、mem0 记忆读写）归用户端（04 §6.6）。凭据本体归 M5（D18）。

# 枚举取值与迁移 0004 CHECK 约束严格对齐（禁止漂移）。
SkillInstallPolicy = Literal["on_demand", "pre_install", "pinned"]


class SkillFileIn(BaseModel):
    """单个技能文件请求体（M2：Manager 持有的技能真相，相对路径 + 内容）。"""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="技能目录内相对路径（posix，例 SKILL.md / references/foo.md）")
    content: str = Field(default="", description="文件文本内容（utf-8）")


SkillBindingPolicy = Literal["opt_in", "auto_bind", "disabled"]
CatalogVisibility = Literal["private", "tenant", "public"]
ConnectorGrantScope = Literal["tenant_wide", "department_scoped", "member_scoped", "disabled"]


class SkillCatalogIn(BaseModel):
    """技能目录写入请求体（runtime 无关，D16）。"""

    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(description="租户内技能标识（中立引用，供 employee.skills 指向）")
    display_name: str = ""
    version: str = Field(default="1", description="技能版本（语义版本或自定标识，runtime 无关）")
    install_policy: SkillInstallPolicy = Field(default="on_demand", description="安装策略")
    binding_policy: SkillBindingPolicy = Field(default="opt_in", description="绑定策略")
    visibility: CatalogVisibility = Field(default="private")
    config: dict = Field(default_factory=dict, description="中立配置（不含 runtime 原生格式，D16）")
    # M2：技能真相（文件列表 + 包级内容哈希）；供 Agent 端 cache 按 version/hash 判定更新。
    files: list[SkillFileIn] = Field(default_factory=list, description="技能文件列表（含 SKILL.md）")
    content_hash: str = Field(default="", description="包级内容指纹（SkillPackage 同步 key）")


class SkillCatalogOut(SkillCatalogIn):
    """技能目录读取响应体（带 catalog 身份与版本）。"""

    catalog_id: str
    catalog_version: int = Field(description="目录条目版本；配置变更单调递增")


class ConnectorCatalogIn(BaseModel):
    """连接器定义写入请求体（runtime 无关，D16）。

    grant_scope 是凭据授权范围元数据（谁能用——仅元数据）；凭据本体（API key/令牌）归 M5（D18），
    本卡不落库也不发起对外调用（红线①③）。
    """

    model_config = ConfigDict(extra="forbid")

    connector_id: str = Field(description="租户内连接器标识（中立引用，供 employee.connector_refs 指向）")
    display_name: str = ""
    visibility: CatalogVisibility = Field(default="private")
    grant_scope: ConnectorGrantScope = Field(default="tenant_wide", description="凭据授权范围元数据（D18）")
    config: dict = Field(default_factory=dict, description="中立配置（不含凭据本体，D18）")


class ConnectorCatalogOut(ConnectorCatalogIn):
    """连接器目录读取响应体（带 catalog 身份与版本）。"""

    catalog_id: str
    catalog_version: int = Field(description="目录条目版本；配置变更单调递增")


class MemoryPolicyCatalogIn(BaseModel):
    """记忆策略目录写入请求体（runtime 无关，D17）。

    记忆复用 mem0（OpenMemory 本地优先 MCP，D17）。本卡只落策略真相（策略/种子/保留期/可见性），
    记忆数据本体在用户端 local_memory_store（04 §6.6），本卡不持有运行时记忆。
    """

    model_config = ConfigDict(extra="forbid")

    policy_id: str = Field(description="租户内记忆策略标识（中立引用，供 employee.memory_policy 指向）")
    display_name: str = ""
    policy: dict = Field(default_factory=dict, description="记忆策略（mem0 可消费的中立配置，D17）")
    seed_memories: list[dict] = Field(default_factory=list, description="种子记忆（策略级，非运行时记忆数据）")
    retention_days: int | None = Field(default=None, ge=0, description="保留期（天）；None 表示不限")
    visibility: CatalogVisibility = Field(default="private")
    config: dict = Field(default_factory=dict, description="中立配置")


class MemoryPolicyCatalogOut(MemoryPolicyCatalogIn):
    """记忆策略目录读取响应体（带 catalog 身份与版本）。"""

    catalog_id: str
    catalog_version: int = Field(description="目录条目版本；配置变更单调递增")



# ---- 招募专家 / 应用方案（M6，05 F06/F07；04 §6.1，D12）----
#
# F06：Manager 租户内招募 → 向 Operator 拉专家模板详情（只读）→ 写本 tenant 的 employee 实例，
#      可绑定部门/成员授权（复用 member_grant，D12）。
# F07：Manager 向 Operator 拉方案包（只读）→ 在本 tenant 创建 solution instance，
#      展开为 employee 实例 + 知识/技能引用 + 默认授权。
#

class RecruitExpertRequest(BaseModel):
    """F06 招募专家请求：指定 Operator 侧模板标识 + 本 tenant 落地参数 + 可选授权绑定。

    employee_slug 可选：由前端显式传入（兼容旧客户端）或由后端按模板 display_name 自动生成
    （slugify + 去重后缀），保持 unique(tenant_id, slug) 约束。
    """

    model_config = ConfigDict(extra="forbid")

    template_id: str = Field(description="Operator 侧专家模板 id（只读拉取来源）")
    template_version: str | None = Field(
        default=None, description="模板版本；空=取 Operator 侧最新"
    )
    employee_slug: str | None = Field(
        default=None, description="本 tenant 内 employee 实例 slug，unique(tenant_id, slug)；空=后端自动生成"
    )
    display_name_override: str | None = Field(
        default=None, description="覆盖模板 display_name；空=用模板 display_name"
    )
    persona_override: str | None = Field(
        default=None, description="覆盖 persona；空=用模板 persona"
    )
    department_ids: list[str] = Field(
        default_factory=list, description="招募即绑定授权部门（D12，落 member_grant）"
    )
    member_ids: list[str] = Field(
        default_factory=list, description="招募即绑定授权成员（D12，落 member_grant）"
    )


class ApplySolutionRequest(BaseModel):
    """F07 应用方案请求：指定 Operator 侧方案标识 + 本 tenant 落地参数。"""

    model_config = ConfigDict(extra="forbid")

    solution_id: str = Field(description="Operator 侧方案 id（只读拉取来源）")
    solution_version: str | None = Field(
        default=None, description="方案版本；空=取 Operator 侧最新"
    )
    display_name_override: str | None = Field(
        default=None, description="覆盖方案 display_name；空=用方案包 display_name"
    )
    department_ids: list[str] = Field(
        default_factory=list, description="方案默认授权部门（D12，展开为各专家的 member_grant）"
    )
    member_ids: list[str] = Field(
        default_factory=list, description="方案默认授权成员（D12，展开为各专家的 member_grant）"
    )


class SolutionInstanceOut(BaseModel):
    """本 tenant 的方案实例真相（F07 展开结果）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    solution_id: str
    solution_version: str
    display_name: str
    status: str
    expert_employee_ids: list[str] = Field(default_factory=list)
    knowledge_refs: list[str] = Field(default_factory=list)
    skill_refs: list[str] = Field(default_factory=list)
    planner_prompt: str = Field(default="", description="方案级协作编排 planner prompt（空=回退运行时默认）")
    subtask_prompt: str = Field(default="", description="方案级协作编排 subtask prompt")
    aggregate_prompt: str = Field(default="", description="方案级协作编排 aggregate prompt")
    created_at: datetime | None = None
    updated_at: datetime | None = None




class RecruitExpertResult(BaseModel):
    """F06 招募结果：落地的 employee 实例 + 来源模板标识 + 是否落了授权 + provider 匹配审计（AITEAM-682）。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    employee_slug: str
    display_name: str
    persona: str | None = None
    source_template_id: str
    source_template_version: str
    grants_applied: bool = Field(
        default=False, description="是否在本 tenant 落了 member_grant 授权（D12）"
    )
    order: RecruitmentOrderOut | None = Field(
        default=None, description="本次招募对应的追踪订单（AITEAM-243；失败/幂等追踪）"
    )
    provider_match_status: str = Field(
        default="",
        description="provider 自动匹配状态：explicit | matched | ambiguous | none（空=未参与匹配）",
    )
    provider_match_candidates: list[str] = Field(
        default_factory=list,
        description="provider 匹配候选（ambiguous 时不为空，供前端让用户选择）",
    )


class ApplySolutionResult(BaseModel):
    """F07 应用方案结果：方案实例 + 展开的专家 employee 列表 + 授权落点。"""

    model_config = ConfigDict(extra="forbid")

    solution_instance: SolutionInstanceOut
    experts: list[RecruitExpertResult] = Field(
        default_factory=list, description="方案包内每个专家展开后的 employee 实例结果"
    )
    grants_applied: bool = Field(default=False, description="是否落了默认授权（D12）")


# ---- 招募订单 RecruitmentOrder（AITEAM-243，对应旧 app/team_panel RecruitmentOrder）----
# 每个 order = 单专家粒度（created_employee_id），状态机：pending → provisioning → succeeded/failed/cancelled。
# 用于追踪异步招募链路、重试与幂等（idempotency_key）。


class RecruitmentOrderOut(BaseModel):
    """招募订单出参（单专家粒度的招募执行追踪）。"""

    model_config = ConfigDict(extra="forbid")

    order_id: str
    idempotency_key: str
    action: str = Field(..., description="recruit_expert | apply_solution")
    template_id: str | None = None
    solution_id: str | None = None
    requested_by: str | None = None
    created_employee_id: str | None = None
    status: str = Field(..., description="pending | provisioning | succeeded | failed | cancelled")
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SolutionApplyRecordOut(BaseModel):
    """方案应用记录出参（AITEAM-242，issue #286）。审计口径：who/when/version/status + 落地专家。"""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="应用记录 id")
    tenant_id: str = Field(description="本 tenant")
    solution_id: str = Field(description="Operator 侧方案 id")
    solution_version: str = Field(description="应用时方案版本")
    applied_by: str | None = Field(description="应用发起者 user_id")
    status: str = Field(description="applied | revoked — 方案应用状态")
    expert_instance_ids: list[str] = Field(default_factory=list, description="应用落到本 tenant 的专家 employee id 列表")
    detail: dict | None = Field(default=None, description="补充信息（如 solution_instance_id / expert_count）")
    created_at: datetime | None = Field(default=None, description="首次应用时间 (applied_at)")
    updated_at: datetime | None = Field(default=None, description="最近更新时间")

# ---- 企业级 usage/audit rollup + 软配额治理（M8，04 §6.5/§6.5.1，D13/D24）----
#
# 红线（D13）：本节 schema 只承载**脱敏聚合摘要**——不含会话文本/prompt/token 明文/工具输入输出
# 明细。上报体对齐 shared.contracts.crosstier.UsageSummaryUpload（A5 上报、本端消费，只 import），
# 落库与出参均无会话内容字段。配额策略 dimensions 为中立维度（cap/threshold），亦不含会话内容。


class UsageRollupOut(BaseModel):
    """计量聚合出参（对齐 shared.contracts.summary.UsageSummary）。无会话内容字段。"""

    model_config = ConfigDict(extra="forbid")

    rollup_id: str
    summary_id: str
    employee_id: str | None = None
    window_start: datetime
    window_end: datetime
    run_count: int = 0
    token_total: int = 0
    cost_total: Decimal = Decimal("0")
    pricing_version: int | None = None
    pricing_status: Literal["known", "unknown"] = "unknown"
    currency: Literal["USD"] = "USD"
    error_count: int = 0
    duration_seconds_total: int = 0


class UsageAggregateOut(BaseModel):
    """按 tenant + 窗口的 usage 聚合（不跨企业汇总，跨企业归 O3）。"""

    model_config = ConfigDict(extra="forbid")

    rollup_count: int
    run_count: int
    token_total: int
    cost_total: Decimal
    unknown_pricing_tokens: int = 0
    unknown_pricing_runs: int = 0
    error_count: int
    duration_seconds_total: int


class AuditSummaryOut(BaseModel):
    """审计事件摘要出参（对齐 shared.contracts.summary.AuditSummaryEvent）。无会话内容。"""

    model_config = ConfigDict(extra="forbid")

    event_id: str
    summary_id: str
    actor: str
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    occurred_at: datetime


class QuotaPolicyIn(BaseModel):
    """软配额策略写入体（D24：默认 soft）。dimensions 为中立维度，不含会话内容。"""

    model_config = ConfigDict(extra="forbid")

    policy_slug: str = Field(description="租户内策略 slug，唯一约束 (tenant_id, policy_slug)")
    display_name: str = ""
    scope: Literal["tenant", "employee", "member"] = "tenant"
    target_ref: str | None = Field(
        default=None, description="scope=employee/member 时的目标 id；scope=tenant 时为空"
    )
    window_start: datetime
    window_end: datetime
    dimensions: dict = Field(
        default_factory=dict,
        description="中立策略维度（如 cost_cap_usd/token_cap/run_cap/threshold），不含会话内容",
    )
    enforcement: Literal["soft", "hard"] = Field(
        default="soft",
        description="soft=告警/建议不阻断（默认，D24）；hard=可选硬配额须显式牺牲离线可用性",
    )
    status: Literal["active", "paused"] = "active"


class QuotaPolicyOut(BaseModel):
    """软配额策略出参。"""

    model_config = ConfigDict(extra="forbid")

    policy_id: str
    policy_slug: str
    display_name: str
    scope: str
    target_ref: str | None = None
    window_start: datetime
    window_end: datetime
    dimensions: dict = Field(default_factory=dict)
    enforcement: str
    status: str
    version: int = Field(description="策略版本；每次配置变更单调递增")


class QuotaEnforcementActionOut(BaseModel):
    """软配额治理动作结果（D24：默认 soft，只产出建议/告警，不阻断 run）。

    红线：不返回 quota lease，不强制阻断——离线时本地继续执行（D14）。
    """

    model_config = ConfigDict(extra="forbid")

    policy_id: str
    policy_slug: str
    enforcement: str
    actions: list[str] = Field(
        default_factory=list,
        description="触达/告警/限流建议等软动作标签（如 notify_owner / alert_threshold / suggest_throttle）",
    )
    severity: str = Field(default="info", description="info | warn | alert")
    detail: str | None = None

# ---- employee_prompt 版本管理 + 历史追踪（issue #303 gap，06 §7.6，D16/D22）----
#
# 红线：
#   - 只承载中立 system_prompt / behavior_rules_json / opening_message；不写 runtime 原生片段，
#     不配置 runtime 启动参数/路径（06 §7.5.3）。
#   - 所有 creator/tenant_id 经 TenantContext，不接受手写 tenant 过滤（D22）。
# version_no：版本号；update 单调 +1，rollback 基于历史版本产生新 version_no（不回退）。
# source_template_version：追溯 prompt 是从哪个 template version 继承的。


class EmployeePromptBase(BaseModel):
    """employee prompt 可编辑字段（中立字段）。"""

    model_config = ConfigDict(extra="forbid")

    system_prompt: str = Field(default="", description="中立 prompt 文本（不写 SOUL.md）")
    behavior_rules_json: dict = Field(
        default_factory=dict,
        description="行为约束 JSON（中立结构；如 {max_turns, forbid_topics,...}，由 Pi 会话直接使用）",
    )
    opening_message: str | None = Field(
        default=None, description="对话开场白（中立文本；由 Pi 会话注入）"
    )
    source_template_version: str | None = Field(
        default=None,
        description="来源模板版本（追溯 prompt 的模板来源；非 manager 版本号）",
    )


class EmployeePromptIn(EmployeePromptBase):
    """创建/更新请求体。"""

    change_reason: str | None = Field(
        default=None, description="本次变更原因（写入历史追溯）"
    )


class EmployeePromptOut(BaseModel):
    """employee_prompt head 出参（中立字段，D16）。由 manager 产出，供用户端装载。"""

    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(description="归属 employee")
    system_prompt: str = ""
    behavior_rules_json: dict = Field(default_factory=dict)
    opening_message: str | None = None
    version_no: int = Field(description="当前版本号（update 单调 +1）")
    source_template_version: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class EmployeePromptHistoryOut(BaseModel):
    """employee_prompt_history 历史版本出参（append-only）。"""

    model_config = ConfigDict(extra="forbid")

    history_id: str = Field(description="历史记录 id")
    employee_id: str = Field(description="归属 employee")
    system_prompt: str = ""
    behavior_rules_json: dict = Field(default_factory=dict)
    opening_message: str | None = None
    version_no: int = Field(description="该历史快照的版本号")
    source_template_version: str | None = None
    change_reason: str | None = None
    changed_by: str | None = None
    created_at: datetime


class EmployeePromptRollbackIn(BaseModel):
    """回滚请求体：回滚到指定历史版本并以此写为新 head。"""

    model_config = ConfigDict(extra="forbid")

    target_version_no: int = Field(description="要回滚到的历史版本号")
    change_reason: str | None = Field(default=None, description="回滚原因（写入历史追溯）")



class InAppNotificationOut(BaseModel):
    """运营通知企业站内信出参（F17）。无会话内容字段（D13）。"""

    model_config = ConfigDict(extra="forbid")

    notification_id: str
    org_id: str
    message: str
    notify_type: str
    severity: str
    read: bool = False
    created_at: str = Field(description="ISO8601 时间戳（由 created_at datetime 序列化）")
