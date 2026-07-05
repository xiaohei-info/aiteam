"""授权配置增量 pull 服务（F10，05 §5.4 / 04 §6.2，D5/D12/D22）。

职责：按 tenant + member_grant 裁剪本 tenant 内可见的 expert 配置，返回增量。
- owner/enterprise_admin 豁免 grant 校验，可见全量（03 §9.7）。
- 普通成员：直接 member_ids 命中，或所属部门 ∈ grant.department_ids → 可见。
- 只读派生：不改任何主数据（D5）。
- tenant_id 全程经 TenantContext（D22）。
"""

from __future__ import annotations

from shared.contracts.crosstier import AuthorizedConfigPullRequest, AuthorizedConfigPullResponse
from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from .employee_config_service import EmployeeConfigService
from .member_service import GrantService, MemberDeptService
from .recruit_repository import RecruitRepository

_GRANT_EXEMPT_ROLES = frozenset({
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
})


class AuthorizedConfigService:
    """按 member_grant 裁剪本 tenant 可见的 expert 配置，返回增量（F10）。"""

    def __init__(
        self,
        *,
        config_service: EmployeeConfigService,
        grant_service: GrantService,
        member_service: MemberDeptService,
        recruit_repository: RecruitRepository | None = None,
    ):
        self._config = config_service
        self._grants = grant_service
        self._members = member_service
        self._recruit_repo = recruit_repository

    def pull(
        self, ctx: TenantContext, req: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        """返回增量授权配置。

        1. 取 member 可见的 employee_id / solution_id 集合（按 grant 裁剪，管理角色豁免）。
        2. 对比 known_versions：版本不同或从未 known → 加入 experts/solutions 增量。
        3. known_versions 中已不可见的 id → revoked_ids。
        """
        all_configs = self._config.list_all(ctx)
        all_employee_ids = {c.employee_id for c in all_configs}

        all_solution_instances = self._recruit_repo.list_solution_instances(ctx) if self._recruit_repo else []
        all_solution_ids = {s.id for s in all_solution_instances}

        if set(ctx.roles) & _GRANT_EXEMPT_ROLES:
            authorized_employee_ids = all_employee_ids
            authorized_solution_ids = all_solution_ids
        else:
            authorized_employee_ids = self._authorized_employee_ids(ctx, req.member_id)
            authorized_solution_ids = self._authorized_solution_ids(ctx, req.member_id)

        experts: list[dict] = []
        for cfg in all_configs:
            if cfg.employee_id not in authorized_employee_ids:
                continue
            known_ver = req.known_versions.get(cfg.employee_id)
            if known_ver != str(cfg.version):
                experts.append(cfg.model_dump(mode="json"))

        solutions: list[dict] = []
        for sol_instance in all_solution_instances:
            if sol_instance.id not in authorized_solution_ids:
                continue
            known_ver = req.known_versions.get(sol_instance.id)
            # Prompt/expert changes are not reflected in solution_version; use config_version so Agent re-syncs.
            current_ver = f"{sol_instance.solution_version}:{sol_instance.config_version}"
            if known_ver != current_ver:
                solutions.append({
                    "id": sol_instance.id,
                    "solution_id": sol_instance.solution_id,
                    "solution_version": sol_instance.solution_version,
                    "display_name": sol_instance.display_name,
                    "status": sol_instance.status,
                    "config_version": sol_instance.config_version,
                    "expert_employee_ids": sol_instance.expert_employee_ids,
                    "knowledge_refs": sol_instance.knowledge_refs,
                    "skill_refs": sol_instance.skill_refs,
                    # 方案级固定编排三阶段 prompts（parity Operator solution_template）
                    "planner_prompt": sol_instance.planner_prompt or "",
                    "subtask_prompt": sol_instance.subtask_prompt or "",
                    "aggregate_prompt": sol_instance.aggregate_prompt or "",
                })

        revoked_ids = [
            rid for rid in req.known_versions
            if (rid not in authorized_employee_ids and rid not in authorized_solution_ids)
            or (rid not in all_employee_ids and rid not in all_solution_ids)
        ]

        return AuthorizedConfigPullResponse(experts=experts, solutions=solutions, revoked_ids=revoked_ids)

    def _authorized_employee_ids(self, ctx: TenantContext, member_id: str) -> set[str]:
        """取该 member 通过 member_grant 可访问的 employee_id 集合。

        成员记录不存在（NotFound）视为无可见集合——属业务预期。其它异常（PG 连接失败、
        RLS 拒绝等）必须透传给入口异常处理器转为 5xx，避免被静默吞成"空响应"，
        在 Agent 端表现为"所有专家授权被撤销"。详见 issue #102 review（MEDIUM）。
        """
        try:
            member = self._members.get_member(ctx, member_id)
        except NotFound:
            return set()
        member_depts = set(member.department_ids)
        grants = self._grants.list_grants(ctx)
        return {
            g.resource_id
            for g in grants
            if g.resource_type == "expert"
            and (member_id in g.member_ids or member_depts & set(g.department_ids))
        }

    def _authorized_solution_ids(self, ctx: TenantContext, member_id: str) -> set[str]:
        """取该 member 通过 member_grant 可访问的 solution_id 集合。

        与 _authorized_employee_ids 逻辑类似，但针对 solution 资源类型。
        成员记录不存在（NotFound）视为无可见集合。
        """
        try:
            member = self._members.get_member(ctx, member_id)
        except NotFound:
            return set()
        member_depts = set(member.department_ids)
        grants = self._grants.list_grants(ctx)
        return {
            g.resource_id
            for g in grants
            if g.resource_type == "solution"
            and (member_id in g.member_ids or member_depts & set(g.department_ids))
        }
