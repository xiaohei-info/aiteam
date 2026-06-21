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
    ):
        self._config = config_service
        self._grants = grant_service
        self._members = member_service

    def pull(
        self, ctx: TenantContext, req: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        """返回增量授权配置。

        1. 取 member 可见的 employee_id 集合（按 grant 裁剪，管理角色豁免）。
        2. 对比 known_versions：版本不同或从未 known → 加入 experts 增量。
        3. known_versions 中已不可见的 id → revoked_ids。
        """
        all_configs = self._config.list_all(ctx)
        all_ids = {c.employee_id for c in all_configs}

        if set(ctx.roles) & _GRANT_EXEMPT_ROLES:
            authorized_ids = all_ids
        else:
            authorized_ids = self._authorized_employee_ids(ctx, req.member_id)

        experts: list[dict] = []
        for cfg in all_configs:
            if cfg.employee_id not in authorized_ids:
                continue
            known_ver = req.known_versions.get(cfg.employee_id)
            if known_ver != str(cfg.version):
                experts.append(cfg.model_dump(mode="json"))

        revoked_ids = [
            eid for eid in req.known_versions
            if eid not in authorized_ids or eid not in all_ids
        ]

        # TODO(follow-up): solutions 裁剪逻辑暂未实现，F10 scope 只覆盖 expert。
        return AuthorizedConfigPullResponse(experts=experts, solutions=[], revoked_ids=revoked_ids)

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
