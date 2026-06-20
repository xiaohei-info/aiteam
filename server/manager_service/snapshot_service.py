"""EmployeeExecutionSnapshot 生成服务（M7，04 §6.2/§6.3 / 05 F11/F16，D5）。

职责（窄）：按 (member_id, employee_id, version) 从**已有 employee 配置**（M2）派生**只读**执行快照。
- 成员级授权权威（04 §6.2 / 05 F16）：取配置**前**先按 member_grant 校验该 member（或其部门）
  对该专家是否有有效授权；无授权 → Forbidden(403)。owner/enterprise_admin 豁免（03 §9.7）。
  enforcement 在 Manager 侧落地，不下放到不可信用户端。
- 只读执行配置投影：绝不提供修改 employee/专家主数据的能力（D5 红线）。
- 不负责用户端冻结：Manager 只生成快照；冻结/落本地库在用户端 Agent Service（D5/F11）。
- 租户隔离：经 EmployeeConfigService / GrantService / MemberDeptService（TenantContext / RLS），
  只读本租户数据（D22），不手写 tenant 过滤。
- 幂等：同 (employee_id, version) 多次生成得同一 snapshot_version 与内容（确定性派生）。
"""

from __future__ import annotations

import hashlib
import json

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound

from .employee_config_service import EmployeeConfigService
from .member_service import GrantService, MemberDeptService
from .schemas import EmployeeConfigOut

# 豁免成员级 grant 的管理角色（03 §9.7：管理角色可见全部专家，不受 member_grant 约束）。
_GRANT_EXEMPT_ROLES = frozenset({
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
})


class SnapshotService:
    """按 member_id + employee_id + version 生成只读执行快照。无任何写路径（D5）。"""

    def __init__(
        self,
        *,
        config_service: EmployeeConfigService,
        grant_service: GrantService,
        member_service: MemberDeptService,
    ):
        self._config = config_service
        self._grants = grant_service
        self._members = member_service

    def generate(
        self,
        ctx: TenantContext,
        *,
        member_id: str,
        employee_id: str,
        employee_version: str | None = None,
    ) -> EmployeeExecutionSnapshot:
        """从本租户的 employee 配置派生执行快照。

        - 先做成员级授权校验：member 无 expert grant → Forbidden(403)（05 F16，04 §6.2）。
        - employee_version 为空 → 取当前配置版本。
        - 指定版本但与当前配置版本不符 → 404（旧版本不保留，无法重建快照，05 F11）。
        - 跨租户/不存在的 employee → EmployeeConfigService 经 RLS 抛 NotFound（404，D22）。
        """
        self._authorize(ctx, member_id=member_id, employee_id=employee_id)

        config = self._config.get(ctx, employee_id=employee_id)  # 跨租户/不存在 → NotFound（RLS）

        current_version = str(config.version)
        if employee_version is not None and employee_version != current_version:
            raise NotFound(
                f"employee version {employee_version} not available "
                f"(current version is {current_version})"
            )

        return _to_snapshot(config, version=current_version)

    def _authorize(self, ctx: TenantContext, *, member_id: str, employee_id: str) -> None:
        """成员级授权 enforcement（04 §6.2 / 05 F16）。

        管理角色（owner/enterprise_admin）豁免；其余成员须命中该专家的 member_grant
        （直接 member_ids 命中，或其部门 ∈ grant.department_ids）。无授权 → 403。
        TODO(audit): 越权拦截应记 enterprise_audit（05 F16）；审计基础设施尚未落地，
        跟进 issue 补 hook，此处 403 拦截已生效。
        """
        if set(ctx.roles) & _GRANT_EXEMPT_ROLES:
            return
        if not self._member_has_expert_grant(ctx, member_id=member_id, employee_id=employee_id):
            raise Forbidden("member is not authorized for this expert")

    def _member_has_expert_grant(
        self, ctx: TenantContext, *, member_id: str, employee_id: str
    ) -> bool:
        """member（或其部门）是否对该 expert 有有效 member_grant（经 GrantService/RLS）。"""
        grants = self._grants.list_grants_by_resource(
            ctx, resource_type="expert", resource_id=employee_id
        )
        if not grants:
            return False

        member = self._members.get_member(ctx, member_id)  # 不存在 → NotFound（404，越权前提失败）
        member_departments = set(member.department_ids)

        for grant in grants:
            if member_id in grant.member_ids:
                return True
            if member_departments & set(grant.department_ids):
                return True
        return False


def _to_snapshot(config: EmployeeConfigOut, *, version: str) -> EmployeeExecutionSnapshot:
    """EmployeeConfigOut（中立配置真相）→ EmployeeExecutionSnapshot（只读执行投影）。

    snapshot_version 为内容确定性派生：同 (employee_id, version, 配置内容) → 同值，
    保证幂等与对账（05 §5.1 只读可幂等重试）。
    """
    snapshot_version = _derive_snapshot_version(config, version=version)
    return EmployeeExecutionSnapshot(
        employee_id=config.employee_id,
        version=version,
        snapshot_version=snapshot_version,
        display_name=config.display_name,
        persona=config.persona,
        model_policy=config.model_policy,
        runtime_policy=config.runtime_policy,
        tools=list(config.tools),
        skills=list(config.skills),
        knowledge_refs=list(config.knowledge_refs),
        connector_refs=list(config.connector_refs),
        memory_policy=config.memory_policy,
    )


def _derive_snapshot_version(config: EmployeeConfigOut, *, version: str) -> str:
    """确定性派生 snapshot_version：sha256(employee_id|version|规范化配置内容) 前 16 hex。

    用 Pydantic 规范化 JSON（排序键、剔除快照专属字段）作内容指纹——
    同输入恒得同值（幂等），配置内容变更则版本变更（对账可追溯）。
    """
    payload = config.model_dump(
        mode="json",
        exclude={"employee_id", "employee_slug", "version"},
    )
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(f"{config.employee_id}|{version}|{canonical}".encode()).hexdigest()
    return f"snap_{version}_{digest[:16]}"


def build_snapshot_service(
    *,
    config_service: EmployeeConfigService,
    grant_service: GrantService,
    member_service: MemberDeptService,
) -> SnapshotService:
    return SnapshotService(
        config_service=config_service,
        grant_service=grant_service,
        member_service=member_service,
    )
