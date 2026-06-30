"""招募专家 / 应用方案业务编排（M6，05 F06/F07 / 04 §6.1，D12/D16）。

编排职责：
- F06 招募专家：向 Operator 单向拉模板详情（只读，OperatorCatalogPort）→ 在本 tenant 建
  employee 实例（复用 EmployeeConfigRepository，runtime 中立 D16）→ 可选落 member_grant 授权
  （复用 GrantRepository，D12）→ 追加 recruit_event 审计。
- F07 应用方案：向 Operator 单向拉方案包（只读）→ 在本 tenant 建 solution_instance → 逐个专家
  展开 employee 实例 + 绑定知识/技能引用 → 按方案默认授权落 member_grant（D12）→ 追加审计。

红线（05 F06/F07）：
- Operator 不写 Manager 库（本卡 Manager 单向拉；模板/方案真相只在 Operator 侧，Manager 只读用）。
- Manager 不改模板真相（拉下来的 ExpertTemplateDetail / SolutionPackage 只作只读输入，落本地实例）。
- tenant_id 全程经 TenantContext，业务 SQL 不接受手写 tenant 过滤（D22）；跨租户串线由 RLS 拒绝。

写操作角色门（03 §9.7）：招募/应用方案需 owner/enterprise_admin（与 employee_config 一致）。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound

from .employee_config_repository import EmployeeConfigRepository
from .operator_catalog import OperatorCatalogPort
from .recruit_order_repository import RecruitOrderRepository
from .recruit_repository import RecruitRepository, SolutionInstanceRow
from .repository_member import GrantRepository
from .schemas import (
    ApplySolutionRequest,
    ApplySolutionResult,
    RecruitExpertRequest,
    RecruitExpertResult,
    RecruitmentOrderOut,
    SolutionInstanceOut,
)

# 招募/应用方案写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_RECRUIT_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


class RecruitService:
    """招募专家 + 应用方案编排。tenant_id 全程取自 TenantContext，不手写过滤（D22）。"""

    def __init__(
        self,
        *,
        catalog: OperatorCatalogPort,
        employees: EmployeeConfigRepository,
        grants: GrantRepository,
        recruit: RecruitRepository,
        orders: RecruitOrderRepository,
    ):
        self._catalog = catalog
        self._employees = employees
        self._grants = grants
        self._recruit = recruit
        self._orders = orders

    # ---- F06 招募专家 ----
    def recruit_expert(
        self, ctx: TenantContext, req: RecruitExpertRequest
    ) -> RecruitExpertResult:
        """F06：拉模板 → 建 employee 实例 → 可选授权 → 审计（追踪 order lifecycle）。"""
        _ensure_can_write(ctx)

        # 1) 单向拉模板详情（只读，不改 Operator 真相；Operator 不写 Manager 库）。
        template = self._catalog.pull_expert_template(
            template_id=req.template_id, version=req.template_version
        )

        if self._employees.get_by_slug(ctx, employee_slug=req.employee_slug) is not None:
            raise Conflict("employee slug already exists in this tenant")

        # 2) 建招募追踪订单（pending → provisioning）；幂等键 = template+slug。
        idem = _idempotency_key(template.template_id, req.employee_slug)
        order = _track_provision(self._orders, ctx, idem=idem, template_id=template.template_id)

        recommended = template.recommended_config or {}
        try:
            row = self._employees.create(
                ctx,
                employee_slug=req.employee_slug,
                display_name=req.display_name_override or template.display_name,
                persona=req.persona_override or template.persona,
                model=recommended.get("model"),
                provider_ref=recommended.get("provider_ref"),
                thinking_level=recommended.get("thinking_level"),
                runtime_binding=recommended.get("runtime_binding"),
                timeout_seconds=recommended.get("timeout_seconds"),
                tools=list(recommended.get("tools", [])),
                skills=list(recommended.get("skills", [])),
                knowledge_refs=list(recommended.get("knowledge_refs", [])),
                connector_refs=list(recommended.get("connector_refs", [])),
                memory_policy=recommended.get("memory_policy"),
            )

            # 3) 可选招募即绑定授权（D12：部门/成员级授权）。无 subject 则跳过（grants_applied=False）。
            grants_applied = False
            if req.department_ids or req.member_ids:
                _upsert_grant(
                    self._grants, ctx,
                    resource_type="expert", resource_id=row.employee_id,
                    department_ids=list(req.department_ids), member_ids=list(req.member_ids),
                )
                grants_applied = True

            # 4) 审计（F06/F07 审计口径，04 §6.1.3；不记会话内容）。
            self._recruit.append_recruit_event(
            ctx,
            action="recruit_expert",
            actor_user_id=ctx.user_id,
            source_template_id=template.template_id,
            source_template_version=template.version,
            target_employee_ids=[row.employee_id],
            detail={"employee_slug": row.employee_slug},
        )
        except Exception as exc:
            failed = order.mark_failed(
                error_code=_error_code(exc), error_message=str(exc)[:1000]
            )
            self._orders.update(ctx, failed)
            raise

        # 5) 订单落 succeeded（携带 created_employee_id，供后续复盘/重试）。
        completed = order.mark_succeeded(row.employee_id)
        self._orders.update(ctx, completed)

        return RecruitExpertResult(
            employee_id=row.employee_id,
            employee_slug=row.employee_slug,
            display_name=row.display_name,
            persona=row.persona,
            source_template_id=template.template_id,
            source_template_version=template.version,
            grants_applied=grants_applied,
            order=_order_out(completed),
        )

    # ---- F07 应用方案 ----
    def apply_solution(
        self, ctx: TenantContext, req: ApplySolutionRequest
    ) -> ApplySolutionResult:
        """F07：拉方案包 → 建 solution_instance → 展开专家/知识/技能 + 默认授权 → 审计。"""
        _ensure_can_write(ctx)

        # 1) 单向拉方案包（只读；方案真相只在 Operator 侧，Manager 只读用）。
        package = self._catalog.pull_solution_package(
            solution_id=req.solution_id, version=req.solution_version
        )

        # 2) 本 tenant 方案实例幂等：同 (solution_id, version) 已存在 → 冲突（避免重复展开）。
        if self._recruit.find_solution_instance(
            ctx, solution_id=package.solution_id, solution_version=package.version
        ) is not None:
            raise Conflict("solution instance already applied in this tenant")

        # 逐个专家的招募追踪订单（apply_solution 粒度）。
        orders: list[RecruitmentOrderOut] = []

        # 3) 逐个专家展开 employee 实例（slug 用 solution 派生，保证可复入幂等可读）。
        expert_results: list[RecruitExpertResult] = []
        expert_employee_ids: list[str] = []
        for idx, template in enumerate(package.experts):
            slug = _derive_solution_expert_slug(package.solution_id, package.version, idx)
            # 展开前确保 slug 未被占用（被占则报冲突，由调用方决策换 version / 换 slug）。
            if self._employees.get_by_slug(ctx, employee_slug=slug) is not None:
                raise Conflict(f"employee slug collision during solution expansion: {slug}")
            order = _track_provision(
                self._orders, ctx,
                idem=_idempotency_key(template.template_id, slug),
                template_id=template.template_id,
                solution_id=package.solution_id,
            )
            recommended = (template.recommended_config or {})
            try:
                row = self._employees.create(
                    ctx,
                    employee_slug=slug,
                    display_name=template.display_name,
                    persona=template.persona,
                    model=recommended.get("model"),
                    provider_ref=recommended.get("provider_ref"),
                    thinking_level=recommended.get("thinking_level"),
                    runtime_binding=recommended.get("runtime_binding"),
                    timeout_seconds=recommended.get("timeout_seconds"),
                    tools=list(recommended.get("tools", [])),
                    skills=list(recommended.get("skills", []))
                    + list(package.skill_refs),  # 方案级技能引用叠加到每个专家
                    knowledge_refs=list(recommended.get("knowledge_refs", []))
                    + list(package.knowledge_refs),  # 方案级知识引用叠加
                    connector_refs=list(recommended.get("connector_refs", [])),
                    memory_policy=recommended.get("memory_policy"),
                )
            except Exception as exc:
                failed = order.mark_failed(_error_code(exc), str(exc)[:1000])
                self._orders.update(ctx, failed)
                raise
            expert_employee_ids.append(row.employee_id)
            # 订单落 succeeded（携带 created_employee_id）。
            done = order.mark_succeeded(row.employee_id)
            self._orders.update(ctx, done)
            fin = _order_out(done)
            orders.append(fin)

            expert_results.append(
                RecruitExpertResult(
                    employee_id=row.employee_id,
                    employee_slug=row.employee_slug,
                    display_name=row.display_name,
                    persona=row.persona,
                    source_template_id=template.template_id,
                    source_template_version=template.version,
                    grants_applied=False,
                    order=fin,
                )
            )

        # 4) 落方案默认授权（D12）：方案包默认授权或请求指定授权 → 展开到每个专家的 member_grant。
        grants_applied = False
        grant_dept_ids = list(req.department_ids)
        grant_member_ids = list(req.member_ids)
        if not (grant_dept_ids or grant_member_ids) and package.default_grants:
            grant_dept_ids = list(package.default_grants.get("department_ids", []))
            grant_member_ids = list(package.default_grants.get("member_ids", []))
        if (grant_dept_ids or grant_member_ids) and expert_employee_ids:
            for employee_id in expert_employee_ids:
                _upsert_grant(
                    self._grants, ctx,
                    resource_type="expert", resource_id=employee_id,
                    department_ids=grant_dept_ids, member_ids=grant_member_ids,
                )
            grants_applied = True

        # 5) 建 solution_instance（本 tenant 展开后的真相）。
        instance = self._recruit.create_solution_instance(
            ctx,
            solution_id=package.solution_id,
            solution_version=package.version,
            display_name=req.display_name_override or package.display_name,
            expert_employee_ids=expert_employee_ids,
            knowledge_refs=list(package.knowledge_refs),
            skill_refs=list(package.skill_refs),
            default_grants_meta=package.default_grants,
            template_meta=package.model_dump(mode="json"),
        )

        # 6) 审计。
        self._recruit.append_recruit_event(
            ctx,
            action="apply_solution",
            actor_user_id=ctx.user_id,
            source_solution_id=package.solution_id,
            source_solution_version=package.version,
            target_employee_ids=expert_employee_ids,
            target_solution_instance_id=instance.id,
            detail={"expert_count": len(expert_employee_ids)},
        )

        return ApplySolutionResult(
            solution_instance=_solution_out(instance),
            experts=expert_results,
            grants_applied=grants_applied,
        )

    # ---- 招募订单查询 ----
    def list_recruit_orders(self, ctx: TenantContext) -> list[RecruitmentOrderOut]:
        return [_order_out(r) for r in self._orders.list_orders(ctx)]

    def get_recruit_order(self, ctx: TenantContext, *, order_id: str) -> RecruitmentOrderOut:
        row = self._orders.get(ctx, order_id=order_id)
        if row is None:
            from shared.errors import NotFound
            raise NotFound("recruitment order not found in this tenant")
        return _order_out(row)

    # ---- 只读查询 ----
    def list_solution_instances(self, ctx: TenantContext) -> list[SolutionInstanceOut]:
        return [_solution_out(r) for r in self._recruit.list_solution_instances(ctx)]

    def get_solution_instance(self, ctx: TenantContext, *, instance_id: str) -> SolutionInstanceOut:
        row = self._recruit.get_solution_instance(ctx, instance_id=instance_id)
        if row is None:
            raise NotFound("solution instance not found in this tenant")
        return _solution_out(row)


def _ensure_can_write(ctx: TenantContext) -> None:
    """招募/应用方案写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_RECRUIT_WRITE_ROLES):
        raise Forbidden("recruit/apply requires owner or enterprise_admin")


def _upsert_grant(
    repo: GrantRepository,
    ctx: TenantContext,
    *,
    resource_type: str,
    resource_id: str,
    department_ids: list[str],
    member_ids: list[str],
) -> None:
    """落 member_grant 授权（D12，复用 M1 GrantRepository，不绕 tenant）。"""
    repo.upsert(
        ctx,
        resource_type=resource_type,
        resource_id=resource_id,
        department_ids=department_ids,
        member_ids=member_ids,
    )


def _derive_solution_expert_slug(solution_id: str, version: str, idx: int) -> str:
    """方案展开专家的 slug 派生（可读 + 幂等：同 solution/version 同序号 → 同 slug）。"""
    sid = solution_id.replace("-", "_").lower()
    ver = version.replace(".", "_").replace("-", "_").lower()
    return f"sol_{sid}_{ver}_e{idx}"


def _solution_out(row: SolutionInstanceRow) -> SolutionInstanceOut:
    return SolutionInstanceOut(
        id=row.id,
        solution_id=row.solution_id,
        solution_version=row.solution_version,
        display_name=row.display_name,
        status=row.status,
        expert_employee_ids=row.expert_employee_ids,
        knowledge_refs=row.knowledge_refs,
        skill_refs=row.skill_refs,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _idempotency_key(template_id: str, slug: str) -> str:
    return f"recruit:{template_id}:{slug}"


def _error_code(exc: BaseException) -> str:
    name = type(exc).__name__
    # 映射常见业务异常为可读 error_code。
    mapping = {
        "Conflict": "employee_slug_conflict",
        "Forbidden": "forbidden",
        "NotFound": "template_not_found",
        "ValueError": "invalid_request",
    }
    return mapping.get(name, name)


def _order_out(row) -> RecruitmentOrderOut:
    return RecruitmentOrderOut(
        order_id=row.id,
        idempotency_key=row.idempotency_key,
        action=row.action,
        template_id=row.template_id,
        solution_id=row.solution_id,
        requested_by=row.requested_by,
        created_employee_id=row.created_employee_id,
        status=row.status,
        error_code=row.error_code,
        error_message=row.error_message,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _track_provision(
    orders: RecruitOrderRepository,
    ctx: TenantContext,
    *,
    idem: str,
    template_id: str,
    solution_id: str | None = None,
) -> RecruitmentOrderRow:
    """幂等创建招募追踪订单并推进到 provisioning（返回行，含状态机）。"""
    existing = orders.get_by_idempotency_key(ctx, idempotency_key=idem)
    if existing is not None:
        return existing
    row = orders.create(
        ctx,
        idempotency_key=idem,
        action="apply_solution" if solution_id else "recruit_expert",
        template_id=template_id,
        solution_id=solution_id,
        requested_by=ctx.user_id,
    )
    provisioning = row.start_provisioning()
    row = orders.update(ctx, provisioning)
    return row


def build_recruit_service(
    *,
    catalog: OperatorCatalogPort,
    router: PgTenantRouter,
) -> RecruitService:
    """组装招募服务：Operator 目录端口（编排注入）+ 共用 PgTenantRouter 派生的各 repository。

    catalog 由编排层注入（生产真实实现 / 测试 FakeOperatorCatalogClient）——本卡 Operator 先 mock。
    """
    return RecruitService(
        catalog=catalog,
        employees=EmployeeConfigRepository(router),
        grants=GrantRepository(router),
        recruit=RecruitRepository(router),
        orders=RecruitOrderRepository(router),
    )


# 显式 re-export 行模型（供测试 import 构造伪 repository）。
__all__ = [
    "RecruitService",
    "build_recruit_service",
]
