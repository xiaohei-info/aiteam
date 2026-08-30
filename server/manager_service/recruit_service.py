"""招募专家 / 应用方案业务编排（M6，05 F06/F07 / 04 §6.1，D12/D16）。

编排职责：
- F06 招募专家：向 Operator 单向拉模板详情（只读，OperatorCatalogPort）→ 在本 tenant 建
  employee 实例（复用 EmployeeConfigRepository，runtime 中立 D16）→ 可选落 member_grant 授权
  （复用 GrantRepository，D12）→ 追加 recruit_event 审计。
- F07 应用方案：向 Operator 单向拉方案包（只读）→ 在本 tenant 建 solution_instance → 逐个专家
  展开 employee 实例 → 固化 coordinator_employee_id/roster → 按本次请求授权落 member_grant（D12）→ 追加审计。

红线（05 F06/F07）：
- Operator 不写 Manager 库（本卡 Manager 单向拉；模板/方案真相只在 Operator 侧，Manager 只读用）。
- Manager 不改模板真相（拉下来的 ExpertTemplateDetail / SolutionPackage 只作只读输入，落本地实例）。
- tenant_id 全程经 TenantContext，业务 SQL 不接受手写 tenant 过滤（D22）；跨租户串线由 RLS 拒绝。

写操作角色门（03 §9.7）：招募/应用方案需 owner/enterprise_admin（与 employee_config 一致）。
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound

from .employee_config_repository import EmployeeConfigRepository
from .operator_catalog import OperatorCatalogPort
from .platform_skill_service import PlatformSkillService
from .recruit_order_repository import RecruitOrderRepository, RecruitmentOrderRow
from .recruit_repository import RecruitRepository, SolutionInstanceRow
from .repository_member import GrantRepository
from .schemas import (
    ApplySolutionRequest,
    ApplySolutionResult,
    RecruitExpertRequest,
    RecruitExpertResult,
    RecruitmentOrderOut,
    SolutionApplyRecordOut,
    SolutionInstanceOut,
)

# 招募/应用方案写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_RECRUIT_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


@dataclass(frozen=True)
class ProviderMatchResult:
    """provider 自动匹配结果（AITEAM-682）。resolver 输出；service 据此写 employee + 审计。

    新 D18 只允许 status=platform：模板固定 Operator Provider/model，tenant access 在创建 employee 前解析成功。
    """

    provider_ref: str | None
    status: str
    candidates: list[str]
    reason: str


def _resolve_platform_model(catalog: OperatorCatalogPort, ctx: TenantContext, template) -> tuple[dict, ProviderMatchResult]:
    ref = template.platform_model_ref
    catalog.resolve_tenant_access(tenant_id=ctx.tenant_id, provider_id=ref.provider_id, model_ids=[ref.model_id])
    recommended = dict(template.recommended_config or {})
    recommended.update({
        "provider_ref": ref.provider_id,
        "provider_version": ref.provider_version,
        "model": ref.model_id,
        "model_version": ref.model_version,
        "platform_model_ref": ref.model_dump(mode="json"),
    })
    return recommended, ProviderMatchResult(
        provider_ref=ref.provider_id,
        status="platform",
        candidates=[ref.provider_id],
        reason="Operator platform model and tenant Relay access resolved",
    )


def _match_detail(recommended: dict, match: ProviderMatchResult) -> dict:
    """recruit_event.detail 中的脱敏匹配审计字段（AITEAM-682；不记 secret）。"""
    return {
        "default_model": recommended.get("model") or None,
        "provider_match_status": match.status,
        "matched_provider_ref": match.provider_ref,
        "candidate_provider_refs": list(match.candidates),
    }


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
        providers=None,
        platform_skills: PlatformSkillService | None = None,
    ):
        self._catalog = catalog
        self._employees = employees
        self._grants = grants
        self._recruit = recruit
        self._orders = orders
        self._platform_skills = platform_skills

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
        if self._employees.get_by_source_template(
            ctx, source_template_id=template.template_id
        ) is not None:
            raise Conflict("expert template already recruited in this tenant")

        # slug 由前端显式传入或后端按模板 display_name 自动生成（+ 去重后缀）；空=自动生成。
        slug = req.employee_slug
        if not slug:
            slug = self._generate_unique_slug(ctx, template)

        if self._employees.get_by_slug(ctx, employee_slug=slug) is not None:
            raise Conflict("employee slug already exists in this tenant")

        # 2) 建招募追踪订单（pending → provisioning）；幂等键 = template+slug。
        idem = _idempotency_key(template.template_id, slug)
        order = _track_provision(self._orders, ctx, idem=idem, template_id=template.template_id)

        recommended, match = _resolve_platform_model(self._catalog, ctx, template)
        skills = self._resolve_skills(ctx, template.platform_skill_refs, recommended)
        try:
            row = self._employees.create(
                ctx,
                employee_slug=slug,
                display_name=req.display_name_override or template.display_name,
                persona=req.persona_override or template.persona,
                model=recommended.get("model"),
                provider_ref=match.provider_ref,
                thinking_level=recommended.get("thinking_level"),
                timeout_seconds=recommended.get("timeout_seconds"),
                tools=list(recommended.get("tools", [])),
                skills=skills,
                knowledge_refs=list(recommended.get("knowledge_refs", [])),
                connector_refs=list(recommended.get("connector_refs", [])),
                memory_policy=recommended.get("memory_policy"),
                source_template_id=template.template_id,
                source_template_version=template.version,
                platform_model_ref=recommended["platform_model_ref"],
                department_ids=list(req.department_ids),
            )
            row = self._employees.transition_status(
                ctx, employee_id=row.employee_id, from_status="draft", to_status="active"
            ) or row

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
            # AITEAM-682：在 detail 中追加脱敏匹配审计（default_model / provider_match_status / 匹配结果；不记 secret）。
            self._recruit.append_recruit_event(
            ctx,
            action="recruit_expert",
            actor_user_id=ctx.user_id,
            source_template_id=template.template_id,
            source_template_version=template.version,
            target_employee_ids=[row.employee_id],
            detail={"employee_slug": row.employee_slug, **_match_detail(recommended, match)},
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
            provider_match_status=match.status,
            provider_match_candidates=list(match.candidates),
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
        _match_audits: list[dict] = []

        # 3) 先预检完整方案，任何 provider/skill/slug/coordinator 错误都必须发生在写 employee 之前。
        ordered_experts = sorted(
            (t for t in package.experts if t.enabled),
            key=lambda t: (t.sequence_no, t.template_id),
        )
        if not ordered_experts:
            raise Conflict("solution package has no enabled experts")
        coordinator_template_id = (
            getattr(package, "coordinator_template_id", "")
            or getattr(package, "planner_template_id", "")
            or ordered_experts[0].template_id
        )
        active_template_ids = {template.template_id for template in ordered_experts}
        if coordinator_template_id not in active_template_ids:
            raise Conflict("solution coordinator must be one of the enabled experts")
        prepared: list[tuple[object, str, dict, ProviderMatchResult, list[str]]] = []
        seen_slugs: set[str] = set()
        for idx, template in enumerate(ordered_experts):
            slug = _derive_solution_expert_slug(package.solution_id, package.version, idx)
            if slug in seen_slugs or self._employees.get_by_slug(ctx, employee_slug=slug) is not None:
                raise Conflict(f"employee slug collision during solution expansion: {slug}")
            seen_slugs.add(slug)
            recommended, match = _resolve_platform_model(self._catalog, ctx, template)
            skills = self._resolve_skills(ctx, template.platform_skill_refs, recommended)
            prepared.append((template, slug, recommended, match, skills))

        expert_results: list[RecruitExpertResult] = []
        expert_employee_ids: list[str] = []
        for template, slug, recommended, match, skills in prepared:
            try:
                order = _track_provision(
                    self._orders, ctx,
                    idem=_idempotency_key(template.template_id, slug),
                    template_id=template.template_id,
                    solution_id=package.solution_id,
                )
            except Exception:
                self._rollback_solution_resources(ctx, expert_employee_ids)
                raise
            created_employee_id: str | None = None
            try:
                row = self._employees.create(
                    ctx,
                    employee_slug=slug,
                    display_name=template.display_name,
                    persona=template.persona,
                    model=recommended.get("model"),
                    provider_ref=match.provider_ref,
                    thinking_level=recommended.get("thinking_level"),
                    timeout_seconds=recommended.get("timeout_seconds"),
                    tools=list(recommended.get("tools", [])),
                    # Skills and knowledge belong to the employee template/tenant bindings.
                    # Never copy deprecated solution-level refs into every employee.
                    skills=skills,
                    knowledge_refs=list(recommended.get("knowledge_refs", [])),
                    connector_refs=list(recommended.get("connector_refs", [])),
                    memory_policy=recommended.get("memory_policy"),
                    platform_model_ref=recommended["platform_model_ref"],
                    department_ids=list(req.department_ids),
                )
                created_employee_id = row.employee_id
                row = self._employees.transition_status(
                    ctx, employee_id=row.employee_id, from_status="draft", to_status="active"
                ) or row
            except Exception as exc:
                failed = order.mark_failed(_error_code(exc), str(exc)[:1000])
                self._orders.update(ctx, failed)
                self._rollback_solution_resources(ctx, [*expert_employee_ids, *([created_employee_id] if created_employee_id else [])])
                raise
            expert_employee_ids.append(row.employee_id)
            done = order.mark_succeeded(row.employee_id)
            self._orders.update(ctx, done)
            fin = _order_out(done)
            orders.append(fin)
            _match_audits.append(_match_detail(recommended, match))
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
                    provider_match_status=match.status,
                    provider_match_candidates=list(match.candidates),
                )
            )

        coordinator_index = next(
            index for index, template in enumerate(ordered_experts)
            if template.template_id == coordinator_template_id
        )
        coordinator_employee_id = expert_employee_ids[coordinator_index]

        # 4) 授权只接受本次 Manager 请求；Operator 不知道目标 tenant 的成员/部门，
        # 因而 deprecated package.default_grants 永远不参与授权。
        grant_dept_ids = list(req.department_ids)
        grant_member_ids = list(req.member_ids)
        try:
            grants_applied = self._apply_solution_grants(
                ctx, expert_employee_ids, grant_dept_ids, grant_member_ids,
            )
        except Exception:
            self._rollback_solution_resources(ctx, expert_employee_ids)
            raise

        # 5) 建 solution_instance（本 tenant 展开后的真相）。
        try:
            instance = self._recruit.create_solution_instance(
                ctx,
                solution_id=package.solution_id,
                solution_version=package.version,
                display_name=req.display_name_override or package.display_name,
                expert_employee_ids=expert_employee_ids,
                # Legacy solution columns remain empty while rolling deployments drain old clients.
                knowledge_refs=[],
                skill_refs=[],
                planner_prompt="",
                subtask_prompt="",
                aggregate_prompt="",
                default_grants_meta=None,
                template_meta=package.model_dump(mode="json"),
                coordinator_employee_id=coordinator_employee_id,
                coordinator_instructions=getattr(package, "coordinator_instructions", ""),
                workflow_skill_ref=getattr(package, "workflow_skill_ref", None),
                output_requirements=getattr(package, "output_requirements", ""),
            )
        except Exception:
            self._rollback_solution_resources(ctx, expert_employee_ids)
            raise

        # 方案本身也必须被授权：Agent 的方案投影按 ``resource_type=solution`` 裁剪，
        # 仅授权展开后的 expert 会让成员能私聊专家、却无法从该方案创建群聊。
        if grant_dept_ids or grant_member_ids:
            try:
                _upsert_grant(
                    self._grants, ctx,
                    resource_type="solution", resource_id=instance.id,
                    department_ids=grant_dept_ids, member_ids=grant_member_ids,
                )
                grants_applied = True
            except Exception:
                self._rollback_solution_resources(ctx, expert_employee_ids, instance.id)
                raise

        try:
            self._record_solution_apply(
                ctx,
                package=package,
                instance=instance,
                employee_ids=expert_employee_ids,
                match_audits=_match_audits,
            )
        except Exception:
            self._rollback_solution_resources(ctx, expert_employee_ids, instance.id)
            raise

        return ApplySolutionResult(
            solution_instance=_solution_out(instance),
            experts=expert_results,
            grants_applied=grants_applied,
        )

    def recruited_template_ids(self, ctx: TenantContext) -> set[str]:
        return self._employees.list_live_source_template_ids(ctx)

    def _record_solution_apply(
        self,
        ctx: TenantContext,
        *,
        package,
        instance: SolutionInstanceRow,
        employee_ids: list[str],
        match_audits: list[dict],
    ) -> None:
        self._recruit.append_recruit_event(
            ctx,
            action="apply_solution",
            actor_user_id=ctx.user_id,
            source_solution_id=package.solution_id,
            source_solution_version=package.version,
            target_employee_ids=employee_ids,
            target_solution_instance_id=instance.id,
            detail={"expert_count": len(employee_ids), "match_audits": match_audits},
        )
        self._recruit.create_solution_apply_record(
            ctx,
            solution_id=package.solution_id,
            solution_version=package.version,
            applied_by=ctx.user_id,
            expert_instance_ids=employee_ids,
            detail={"solution_instance_id": instance.id, "expert_count": len(employee_ids)},
            status="applied",
        )

    def _apply_solution_grants(
        self,
        ctx: TenantContext,
        employee_ids: list[str],
        department_ids: list[str],
        member_ids: list[str],
    ) -> bool:
        if not (department_ids or member_ids) or not employee_ids:
            return False
        for employee_id in employee_ids:
            _upsert_grant(
                self._grants, ctx,
                resource_type="expert", resource_id=employee_id,
                department_ids=department_ids, member_ids=member_ids,
            )
        return True

    def _rollback_solution_resources(self, ctx: TenantContext, employee_ids: list[str], solution_instance_id: str | None = None) -> None:
        """Best-effort compensation for a failed solution apply.

        Employee creation and grants use separate repository transactions today; delete grants
        before employees so FK constraints cannot preserve a half-applied roster. The original
        exception remains authoritative if compensation itself encounters an unavailable row.
        """
        if solution_instance_id:
            try:
                for grant in self._grants.list_by_resource(ctx, resource_type="solution", resource_id=solution_instance_id):
                    self._grants.delete(ctx, grant_id=grant.id)
            except Exception:  # noqa: BLE001 - compensation is best effort
                pass
            try:
                self._recruit.delete_solution_instance(ctx, instance_id=solution_instance_id)
            except Exception:  # noqa: BLE001 - preserve original apply failure
                pass
        for employee_id in reversed(list(dict.fromkeys(employee_ids))):
            try:
                for grant in self._grants.list_by_resource(ctx, resource_type="expert", resource_id=employee_id):
                    self._grants.delete(ctx, grant_id=grant.id)
            except Exception:  # noqa: BLE001 - continue cleaning remaining employees
                pass
            try:
                self._employees.delete(ctx, employee_id=employee_id)
            except Exception:  # noqa: BLE001 - preserve original apply failure
                pass

    def _resolve_skills(self, ctx: TenantContext, refs, recommended: dict) -> list[str]:
        platform_refs = list(refs or recommended.get("platform_skill_refs") or [])
        if platform_refs:
            if self._platform_skills is None:
                raise Conflict("platform skill installer is not configured")
            return self._platform_skills.install_all(ctx, platform_refs)
        return list(recommended.get("skills", []))

    # ---- slug 自动生成（F06 招募时 employee_slug 未传，由后端派生唯一 slug）----
    _SLUGIFY_RE = None
    _SLUG_SPACER_RE = None

    def _generate_unique_slug(self, ctx: TenantContext, template) -> str:
        """按模板 display_name slugify 后生成租户内唯一 slug（[a-z0-9_]，低碰撞、保持可读）。

        汉字/非 ASCII 字符会被剔除；若剔除后为空则回退到 template_id 派生，再 fallback 到短 uuid。
        """
        import re
        import uuid as _uuid

        cls = type(self)
        if cls._SLUGIFY_RE is None:
            # ASCII-only 白名单：只保留 [a-z0-9_-]+ 其它字符（含汉字、全角符号）一律剔除
            cls._SLUGIFY_RE = re.compile(r"[^a-z0-9\s-]")
            cls._SLUG_SPACER_RE = re.compile(r"[\s-]+")

        base = cls._SLUGIFY_RE.sub("", template.display_name.strip().lower())
        base = cls._SLUG_SPACER_RE.sub("_", base).strip("_")

        if not base:
            # display_name 全为非 ASCII 时回退到 template_id 派生
            fallback = cls._SLUGIFY_RE.sub("", template.template_id.lower())
            fallback = cls._SLUG_SPACER_RE.sub("_", fallback).strip("_")
            base = fallback if fallback else f"emp_{_uuid.uuid4().hex[:8]}"

        base = base[:64]

        candidate = base
        for i in range(1, 51):
            if self._employees.get_by_slug(ctx, employee_slug=candidate) is None:
                return candidate
            suffix = f"_{i}"
            candidate = f"{base[:64 - len(suffix)]}{suffix}"
        return f"{base[:56]}_{_uuid.uuid4().hex[:7]}"

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

    # ---- 方案应用记录（AITEAM-242，issue #286）----
    def list_solution_apply_records(
        self,
        ctx: TenantContext,
        *,
        solution_id: str | None = None,
        status: str | None = None,
    ) -> list[SolutionApplyRecordOut]:
        rows = self._recruit.list_solution_apply_records(ctx, solution_id=solution_id, status=status)
        return [_apply_record_out(r) for r in rows]

    def get_latest_solution_apply_record(
        self, ctx: TenantContext, *, solution_id: str
    ) -> SolutionApplyRecordOut:
        row = self._recruit.get_latest_solution_apply_record(ctx, solution_id=solution_id)
        if row is None:
            raise NotFound("no applied solution record in this tenant")
        return _apply_record_out(row)


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
        coordinator_employee_id=row.coordinator_employee_id,
        coordinator_instructions=row.coordinator_instructions,
        workflow_skill_ref=row.workflow_skill_ref,
        output_requirements=row.output_requirements,
        config_version=row.config_version,
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

    catalog 由编排层注入（OPERATOR_URL 缺失时 _build_operator_catalog fail-closed；测试显式注入 FakeOperatorCatalogClient）。
    """
    from .capability_catalog_repository import CapabilityCatalogRepository

    return RecruitService(
        catalog=catalog,
        employees=EmployeeConfigRepository(router),
        grants=GrantRepository(router),
        recruit=RecruitRepository(router),
        orders=RecruitOrderRepository(router),
        platform_skills=PlatformSkillService(operator=catalog, catalog=CapabilityCatalogRepository(router)),
    )


# 显式 re-export 行模型（供测试 import 构造伪 repository）。
__all__ = [
    "RecruitService",
    "build_recruit_service",
]


def _apply_record_out(row) -> SolutionApplyRecordOut:
    return SolutionApplyRecordOut(
        id=row.id,
        tenant_id=row.tenant_id,
        solution_id=row.solution_id,
        solution_version=row.solution_version,
        applied_by=row.applied_by,
        status=row.status,
        expert_instance_ids=row.expert_instance_ids,
        detail=row.detail,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
