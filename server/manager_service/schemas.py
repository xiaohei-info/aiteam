"""企业端业务 API 边界 schema。

- employee/expert 配置（M2，06 §7.5/§7.6 / 04 §6.1，D16）：所有配置字段 **runtime 中立**。
  本文件只 import 共享契约的 ModelPolicy / RuntimePolicy（snapshot.py），不重定义；API 入参/出参
  以此为中立载体，绝不出现 runtime 原生格式（SOUL.md/config.yaml/启动参数——那是用户端 Driver
  的职责，06 §7.5.3）。
- 成员/部门/角色 + member_grant 授权（issue #35；03 §9.7；04 §6.1，D12）：
  角色经 shared.contracts.enums.EnterpriseRole 枚举定义取值（禁用旧 admin/manager/viewer）；
  部门/成员/授权租户作用域 CRUD，tenant_id 全程经 TenantContext（D22），不接受手写过滤；
  授权映射对齐 shared.contracts.grants.MemberGrant（只 import、禁重定义）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

# resource_type 取值（对齐 MemberGrant 契约）。
RESOURCE_TYPES = ("expert", "solution")


# ---- employee/expert 配置载体：复用契约的中立 ModelPolicy / RuntimePolicy，外加 persona 与能力引用 ----

class EmployeeConfig(BaseModel):
    """employee 的中立运行配置真相（runtime 无关）。

    本结构即 M7 EmployeeExecutionSnapshot 的配置来源（去掉 version/snapshot_version 等快照字段）。
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str = ""
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md，D16）")
    model_policy: ModelPolicy = Field(default_factory=ModelPolicy)
    runtime_policy: RuntimePolicy = Field(default_factory=RuntimePolicy)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list, description="技能引用；A 类能力本地经 MCP 注入")
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list)
    memory_policy: dict | None = Field(default=None, description="记忆策略（04 §6.6，mem0）")


class EmployeeConfigIn(EmployeeConfig):
    """写入请求体。继承 EmployeeConfig 全部中立字段。"""

    @model_validator(mode="after")
    def _runtime_neutral(self) -> "EmployeeConfigIn":
        # 守红线（issue 红线：不配置 runtime 非中立）。runtime_binding 只允许中立标识符，
        # 不含启动参数/路径/原生 profile 片段（06 §7.6）。
        rb = self.runtime_policy.runtime_binding
        if rb is not None and not _is_neutral_runtime_binding(rb):
            raise ValueError(
                "runtime_binding 必须是中立 runtime 标识符（小写字母/数字/下划线），"
                "禁止内联 runtime 启动参数或原生 profile（D16）"
            )
        return self


def _is_neutral_runtime_binding(value: str) -> bool:
    """runtime_binding 中立性：仅允许 `[a-z0-9_]+` 标识符（如 hermes_acp、claude_code_json_stream）。

    拒绝任何含路径分隔符、空格、=、-- 等 runtime 参数痕迹的取值——它们属于用户端 Driver（06 §7.3）。
    """
    if not value:
        return False
    return all(c.isalnum() or c == "_" for c in value) and value.isascii() and value.islower()


class EmployeeConfigOut(EmployeeConfig):
    """读取响应体。带 employee 身份与版本（供增量 sync / 快照冻结）。"""

    employee_id: str
    employee_slug: str
    version: int = Field(description="配置版本；每次配置变更单调递增")


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
        description="expert 真相态走 employee.knowledge_refs；department/member 走 knowledge_space_binding 表"
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
