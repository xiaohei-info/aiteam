"""EmployeeExecutionSnapshot 生成服务（M7，04 §6.2/§6.3 / 05 F11/F16，D5）。

职责（窄）：按 (member_id, employee_id, version) 从**已有 employee 配置**（M2）派生**只读**执行快照。
- 成员级授权权威（04 §6.2 / 05 F16）：取配置**前**先按 member_grant 校验该 member（或其部门）
  对该专家是否有有效授权；无授权 → Forbidden(403)。owner/enterprise_admin 豁免（03 §9.7）。
  enforcement 在 Manager 侧落地，不下放到不可信用户端。
- 越权审计（05 F16）：越权拉取被 403 拦截时，记一条 enterprise_audit（actor/resource/拒因，
  不含会话或执行配置内容，D13）。审计写入发生在读取专家配置**之前**，结构上无配置内容可泄。
- 只读执行配置投影：绝不提供修改 employee/专家主数据的能力（D5 红线）。
- 不负责用户端冻结：Manager 只生成快照；冻结/落本地库在用户端 Agent Service（D5/F11）。
- 租户隔离：经 EmployeeConfigService / GrantService / MemberDeptService（TenantContext / RLS），
  只读本租户数据（D22），不手写 tenant 过滤。
- 幂等：同 (employee_id, version) 多次生成得同一 snapshot_version 与内容（确定性派生）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Protocol

from shared.contracts.enums import EnterpriseRole
from shared.contracts.platform_provider import PricingSnapshot
from shared.contracts.snapshot import EmployeeExecutionSnapshot, ExecutionPolicy
from .knowledge_access_policy import KnowledgeAccess, KnowledgeAccessPolicy
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound

from .active_principal import require_active
from .employee_config_service import EmployeeConfigService
from .member_service import GrantService, MemberDeptService
from .schemas import EmployeeConfigOut
from .employee_avatar_repository import EmployeeAvatarRepository

logger = logging.getLogger(__name__)

# 越权拦截审计动作名（05 F16）。
_SNAPSHOT_PULL_DENIED = "snapshot_pull_denied"


class KnowledgeBindingReader(Protocol):
    def list_all(self, ctx: TenantContext, *, employee_id: str): ...


class PlatformCatalogReader(Protocol):
    def list_platform_catalog(self) -> dict: ...


class AuditRecorder(Protocol):
    """本端审计写入口（由 EnterpriseAuditRepository 实现）。只接中立元数据，不接会话/配置内容。"""

    def record(
        self,
        ctx: TenantContext,
        *,
        actor: str,
        action: str,
        resource_type: str | None = ...,
        resource_id: str | None = ...,
        detail: str | None = ...,
    ): ...

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
        audit_recorder: AuditRecorder | None = None,
        knowledge_binding: KnowledgeBindingReader | None = None,
        platform_catalog: PlatformCatalogReader | None = None,
        avatar_repository: EmployeeAvatarRepository | None = None,
    ):
        self._config = config_service
        self._grants = grant_service
        self._members = member_service
        # 可选：None → 不写审计（骨架/单测降级）；真实路由注入 EnterpriseAuditRepository。
        self._audit = audit_recorder
        self._knowledge_binding = knowledge_binding
        self._platform_catalog = platform_catalog
        self._avatars = avatar_repository

    def _ensure_runnable(self, ctx: TenantContext, *, employee_id: str) -> None:
        """Reject non-active employees before an execution backend is contacted."""
        config = self._config.get(ctx, employee_id=employee_id)
        if config.status != "active":
            raise NotFound("employee is not runnable")

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

        policy = KnowledgeAccessPolicy(self._knowledge_binding).resolve(
            ctx, employee_id=employee_id, tools=config.tools, version=current_version,
        )
        avatar = self._avatars.get(ctx, employee_id) if self._avatars is not None else None
        return _to_snapshot(
            config, version=current_version, knowledge_refs=list(policy.refs), knowledge_policy=policy,
            pricing=self._resolve_pricing(config, tenant_id=ctx.tenant_id),
            avatar_url=avatar.avatar_url if avatar else None,
            avatar_version=avatar.version if avatar else 0,
        )

    def _resolve_pricing(self, config: EmployeeConfigOut, *, tenant_id: str) -> PricingSnapshot | None:
        policy = config.model_policy
        if not all((policy.provider_ref, policy.model)):
            return None
        if self._platform_catalog is None:
            # Isolated service fixtures may intentionally omit the Operator
            # catalog; production routes always inject it.
            return None
        try:
            try:
                catalog = self._platform_catalog.list_platform_catalog(tenant_id=tenant_id)
            except TypeError:
                # Keep lightweight test doubles compatible with the pre-policy seam.
                catalog = self._platform_catalog.list_platform_catalog()
        except Exception as exc:  # noqa: BLE001 - local test/faux runtimes may omit Operator catalog
            if os.getenv("AITEAM_ENV", "").strip().lower() != "production":
                return None
            raise NotFound("platform model catalog is unavailable") from exc
        provider = next(
            (item for item in catalog.get("providers", [])
             if item.get("provider_id") == policy.provider_ref),
            None,
        )
        if not provider or provider.get("status") != "published":
            raise NotFound("platform provider is unavailable")
        for item in catalog.get("models", []):
            model = item.get("model") or {}
            rate = item.get("rate") or {}
            if model.get("provider_id") != policy.provider_ref or model.get("model_id") != policy.model:
                continue
            if model.get("status") != "published":
                raise NotFound("platform model is unavailable")
            if rate.get("pricing_status") != "known":
                raise NotFound("platform model price is unknown")
            return PricingSnapshot(**{key: rate.get(key) for key in PricingSnapshot.model_fields})
        raise NotFound("platform model is unavailable")

    def _authorize(self, ctx: TenantContext, *, member_id: str, employee_id: str) -> None:
        """成员级授权 enforcement（04 §6.2 / 05 F16）。

        管理角色（owner/enterprise_admin）豁免；其余成员须命中该专家的 member_grant
        （直接 member_ids 命中，或其部门 ∈ grant.department_ids）。无授权 → 403，并记 enterprise_audit。
        审计写在抛 403 之前、读取专家配置之前——结构上不含任何执行配置内容（05 F16，D13）。
        """
        require_active(self._members.get_member(ctx, member_id))
        if set(ctx.roles) & _GRANT_EXEMPT_ROLES:
            return
        if not self._member_has_expert_grant(ctx, member_id=member_id, employee_id=employee_id):
            self._record_denial(ctx, member_id=member_id, employee_id=employee_id)
            raise Forbidden("member is not authorized for this expert")

    def _record_denial(self, ctx: TenantContext, *, member_id: str, employee_id: str) -> None:
        """记一条越权拉取审计（05 F16）。审计失败不得淹没原始 403（best-effort，吞异常只告警）。"""
        if self._audit is None:
            return
        try:
            self._audit.record(
                ctx,
                actor=member_id,
                action=_SNAPSHOT_PULL_DENIED,
                resource_type="expert",
                resource_id=employee_id,
                detail="member is not authorized for this expert",
            )
        except Exception:  # noqa: BLE001 — best-effort：审计写失败不得把 403 变成 500
            logger.warning(
                "enterprise_audit record failed for snapshot denial "
                "(member=%s employee=%s); original 403 preserved",
                member_id, employee_id, exc_info=True,
            )

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


def _to_snapshot(
    config: EmployeeConfigOut, *, version: str, knowledge_refs: list[str], knowledge_policy: KnowledgeAccess,
    pricing: PricingSnapshot | None = None,
    avatar_url: str | None = None,
    avatar_version: int = 0,
) -> EmployeeExecutionSnapshot:
    """EmployeeConfigOut（中立配置真相）→ EmployeeExecutionSnapshot（只读执行投影）。

    snapshot_version 为内容确定性派生：同 (employee_id, version, 配置内容) → 同值，
    保证幂等与对账（05 §5.1 只读可幂等重试）。
    """
    snapshot_version = _derive_snapshot_version(config, version=version, knowledge_refs=knowledge_refs,
                                                knowledge_policy=knowledge_policy)
    return EmployeeExecutionSnapshot(
        employee_id=config.employee_id,
        version=version,
        snapshot_version=snapshot_version,
        display_name=config.display_name,
        persona=config.persona,
        model_policy=config.model_policy.model_copy(update={"pricing": pricing}),
        execution_policy=ExecutionPolicy(timeout_seconds=config.execution_policy.timeout_seconds),
        tools=list(knowledge_policy.tools),
        knowledge_policy=knowledge_policy.projection,
        skills=list(config.skills),
        knowledge_refs=knowledge_refs,
        connector_refs=list(config.connector_refs),
        memory_policy=config.memory_policy if config.memory_policy is not None else {
            "enabled": True, "scope": "employee", "allowed_operations": ["recall"],
            "explicit_auto_retain": False, "retention_days": None,
        },
        department_ids=list(config.department_ids),
        avatar_url=avatar_url,
        avatar_version=avatar_version,
    )


def _derive_snapshot_version(
    config: EmployeeConfigOut, *, version: str, knowledge_refs: list[str], knowledge_policy: KnowledgeAccess
) -> str:
    """确定性派生 snapshot_version：sha256(employee_id|version|规范化配置内容) 前 16 hex。

    用 Pydantic 规范化 JSON（排序键、剔除快照专属字段）作内容指纹——
    同输入恒得同值（幂等），配置内容变更则版本变更（对账可追溯）。
    """
    payload = config.model_dump(
        mode="json",
        exclude={"employee_id", "employee_slug", "version", "knowledge_refs"},
    )
    payload["knowledge_refs"] = sorted(knowledge_refs)
    payload["knowledge_policy"] = knowledge_policy.projection.model_dump(mode="json")
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(f"{config.employee_id}|{version}|{canonical}".encode()).hexdigest()
    return f"snap_{version}_{digest[:16]}"


def build_snapshot_service(
    *,
    config_service: EmployeeConfigService,
    grant_service: GrantService,
    member_service: MemberDeptService,
    audit_recorder: AuditRecorder | None = None,
    knowledge_binding: KnowledgeBindingReader | None = None,
    platform_catalog: PlatformCatalogReader | None = None,
    avatar_repository: EmployeeAvatarRepository | None = None,
) -> SnapshotService:
    return SnapshotService(
        config_service=config_service,
        grant_service=grant_service,
        member_service=member_service,
        audit_recorder=audit_recorder,
        knowledge_binding=knowledge_binding,
        platform_catalog=platform_catalog,
        avatar_repository=avatar_repository,
    )
