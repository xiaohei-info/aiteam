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
    initial_quota_policy: dict | None = Field(default=None)
    visible_catalog_policy: dict | None = Field(default=None)


class OwnerBootstrapSync(BaseModel):
    """F02 负责人 bootstrap：Operator 同步负责人初始/重置凭据给 Manager tenant。

    仅同步校验/同步所需材料（hash 或一次性），Operator 不持企业长期密码（03 §9.2）。
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    owner_phone: str
    bootstrap_secret_hash: str = Field(description="bootstrap 凭据 hash 或一次性材料，禁明文/可逆")
    must_reset: bool = Field(default=True, description="负责人首登强制重置")


class CatalogReleaseNotify(BaseModel):
    """F03 目录发布：Operator 通知 Manager 模板/方案的发布/下架/可见范围变更。"""

    model_config = ConfigDict(extra="forbid")

    catalog_type: str = Field(description="expert_template | solution_template")
    template_id: str
    version: str
    action: str = Field(description="published | unpublished | visibility_changed")
    visible_scope: dict | None = Field(default=None)


# ---- Manager → Operator（云侧）----

class ExpertTemplateDetail(BaseModel):
    """F06 招募专家：Manager 向 Operator 拉专家模板详情（响应）。Operator 持模板真相，不写 Manager 库。"""

    model_config = ConfigDict(extra="forbid")

    template_id: str
    version: str
    display_name: str
    persona: str | None = None
    recommended_config: dict = Field(default_factory=dict)


class SolutionPackage(BaseModel):
    """F07 应用方案：Manager 向 Operator 拉行业方案包（响应）。在本 tenant 展开为 solution instance。"""

    model_config = ConfigDict(extra="forbid")

    solution_id: str
    version: str
    display_name: str
    experts: list[ExpertTemplateDetail] = Field(default_factory=list)
    knowledge_refs: list[str] = Field(default_factory=list)
    skill_refs: list[str] = Field(default_factory=list)
    default_grants: dict | None = Field(default=None)


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
    solutions: list[dict] = Field(default_factory=list)
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
    usage: list[UsageSummary] = Field(default_factory=list)
    audits: list[AuditSummaryEvent] = Field(default_factory=list)
