"""共享契约（Single Source of Truth）。

本包是 v1 三端「高风险共享口径」的**唯一代码事实源**：北向 envelope/错误模型、
状态/角色枚举、token claims、TenantContext、运行事件与时间线事件、RunSpec、
Executor/Driver 抽象、执行快照、成员级授权与本地投影、脱敏摘要、跨系统 pull 契约。

== 防跑偏铁律（对所有 Coding Agent）==
1. 下游模块（operation_service / manager_service / agent_service / agent_gateway /
   web）**只能 import 本包的类型，禁止自定义平行 DTO / 事件名 / cursor / 枚举**。
2. 修改本包属「修改共享口径」，是 CLAUDE.md §8 的高风险操作，需显式确认 + 评审。
3. 每个类型上的 docstring 标注其对应的 v1 概要设计篇/§ 与裁决 D#，实现须回查该处。

对应文档：02（API/错误模型）、03（认证）、04（数据/快照/授权/摘要）、
05（通信/跨端契约）、06（Gateway/RunSpec）、07（事件/时间线/状态枚举）。
"""

from .auth import AuthIdentity, TokenClaims, UserPrincipal
from .crosstier import (
    AuthorizedConfigPullRequest,
    AuthorizedConfigPullResponse,
    CatalogReleaseNotify,
    ExpertTemplateDetail,
    OwnerBootstrapSync,
    SnapshotPullRequest,
    SnapshotPullResponse,
    SolutionPackage,
    TenantProvisionRequest,
    UsageSummaryUpload,
)
from .enums import (
    AuthProvider,
    ConversationState,
    DisplayState,
    EnterpriseRole,
    IsolationLevel,
    PlatformRole,
)
from .envelope import Envelope, ListEnvelope, Page, Problem, ProblemFieldError
from .events import (
    AgentRuntimeEvent,
    BusinessTimelineEvent,
    RuntimeEventType,
    TimelineCursor,
)
from .gateway import Driver, Executor, RuntimeCapability
from .grants import LoadedExpertProjection, MemberGrant
from .runspec import AgentRunRequest, McpServerConfig, RunSpec
from .snapshot import EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy
from .summary import AuditSummaryEvent, UsageSummary
from .tenancy import TenantContext

__all__ = [
    "AuthIdentity",
    "TokenClaims",
    "UserPrincipal",
    "AuthorizedConfigPullRequest",
    "AuthorizedConfigPullResponse",
    "CatalogReleaseNotify",
    "ExpertTemplateDetail",
    "OwnerBootstrapSync",
    "SnapshotPullRequest",
    "SnapshotPullResponse",
    "SolutionPackage",
    "TenantProvisionRequest",
    "UsageSummaryUpload",
    "AuthProvider",
    "ConversationState",
    "DisplayState",
    "EnterpriseRole",
    "IsolationLevel",
    "PlatformRole",
    "Envelope",
    "ListEnvelope",
    "Page",
    "Problem",
    "ProblemFieldError",
    "AgentRuntimeEvent",
    "BusinessTimelineEvent",
    "RuntimeEventType",
    "TimelineCursor",
    "Driver",
    "Executor",
    "RuntimeCapability",
    "LoadedExpertProjection",
    "MemberGrant",
    "AgentRunRequest",
    "McpServerConfig",
    "RunSpec",
    "EmployeeExecutionSnapshot",
    "ModelPolicy",
    "RuntimePolicy",
    "AuditSummaryEvent",
    "UsageSummary",
    "TenantContext",
]
