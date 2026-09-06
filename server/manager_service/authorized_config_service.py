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
from shared.contracts.skill import SignedSkillPackage
from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from .active_principal import require_active
from .knowledge_access_policy import KnowledgeAccessPolicy
from .capability_catalog_service import CapabilityCatalogService
from .employee_config_service import EmployeeConfigService
from .member_service import GrantService, MemberDeptService
from .recruit_repository import RecruitRepository
from .skill_signing import SkillPackageSigner

_GRANT_EXEMPT_ROLES = frozenset({
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
})


def _catalog_row_to_out(row) -> SkillCatalogOut:
    """把 capability_catalog_row 转成安全的 SkillCatalogOut 投影。

    Legacy JSONB rows may contain an object/scalar in ``files``.  Keep those
    rows inspectable through ``package_status=invalid`` without iterating their
    value as if it were a list of executable files.
    """
    from .custom_skill_package import package_status
    from .schemas import SkillCatalogOut
    files_raw = getattr(row, "files", None)
    # Keep the raw JSONB shape in the authorized projection.  A malformed
    # scalar/object remains inspectable and invalid; it must not be iterated,
    # string-coerced, or replaced with a fabricated empty package.
    return SkillCatalogOut(
        catalog_id=getattr(row, "catalog_id", "") or "",
        skill_id=row.skill_id, display_name=getattr(row, "display_name", ""),
        version=getattr(row, "version", "1"),
        install_policy=getattr(row, "install_policy", "on_demand"),
        binding_policy=getattr(row, "binding_policy", "opt_in"),
        visibility=getattr(row, "visibility", "private"),
        config=config if isinstance(config := getattr(row, "config", {}), dict) else {},
        files=files_raw, content_hash=getattr(row, "content_hash", "") or "",
        catalog_version=getattr(row, "catalog_version", 0) or 0,
        package_status=package_status(row),
    )


class AuthorizedConfigService:
    """按 member_grant 裁剪本 tenant 可见的 expert 配置，返回增量（F10）。"""

    def __init__(
        self,
        *,
        config_service: EmployeeConfigService,
        grant_service: GrantService,
        member_service: MemberDeptService,
        recruit_repository: RecruitRepository | None = None,
        capability_catalog: CapabilityCatalogService | None = None,
        skill_signer: SkillPackageSigner | None = None,
        knowledge_policy: KnowledgeAccessPolicy | None = None,
    ):
        self._config = config_service
        self._knowledge_policy = knowledge_policy or KnowledgeAccessPolicy()
        self._grants = grant_service
        self._members = member_service
        self._recruit_repo = recruit_repository
        self._capability = capability_catalog
        self._skill_signer = skill_signer if skill_signer is not None else SkillPackageSigner.from_env()

    def pull(
        self, ctx: TenantContext, req: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        """返回增量授权配置。

        1. 取 member 可见的 employee_id / solution_id 集合（按 grant 裁剪，管理角色豁免）。
        2. 对比 known_versions：版本不同或从未 known → 加入 experts/solutions 增量。
        3. known_versions 中已不可见的 id → revoked_ids。
        4. M2：解析 authorized experts[].skills 的 skill_id 集合 → 技能包真相（仅限
           Manager capability_catalog 有记录的 skill_id），技能真相供 Agent skill_cache
           按 version/hash 判定更新。capability_catalog 未提供 → skill_packages 置 []（D14）。
        """
        require_active(self._members.get_member(ctx, req.member_id))
        all_configs = self._config.list_all(ctx)
        all_employee_ids = {c.employee_id for c in all_configs}

        all_solution_instances = self._recruit_repo.list_solution_instances(ctx) if self._recruit_repo else []
        all_solution_ids = {s.id for s in all_solution_instances}
        applied_solution_ids = {s.id for s in all_solution_instances if s.status == "applied"}

        if set(ctx.roles) & _GRANT_EXEMPT_ROLES:
            authorized_employee_ids = all_employee_ids
            authorized_solution_ids = applied_solution_ids
        else:
            authorized_employee_ids = self._authorized_employee_ids(ctx, req.member_id)
            authorized_solution_ids = self._authorized_solution_ids(ctx, req.member_id) & applied_solution_ids

        authorized_configs = [cfg for cfg in all_configs if cfg.employee_id in authorized_employee_ids]
        experts: list[dict] = []
        for cfg in authorized_configs:
            known_ver = req.known_versions.get(cfg.employee_id)
            if known_ver != str(cfg.version):
                policy = self._knowledge_policy.resolve(
                    ctx, employee_id=cfg.employee_id, tools=cfg.tools, version=str(cfg.version),
                )
                experts.append({**cfg.model_dump(mode="json"), "tools": list(policy.tools),
                                "knowledge_refs": list(policy.refs),
                                "knowledge_policy": policy.projection.model_dump(mode="json")})

        solutions: list[dict] = []
        for sol_instance in all_solution_instances:
            if sol_instance.id not in authorized_solution_ids or sol_instance.status != "applied":
                continue
            known_ver = req.known_versions.get(sol_instance.id)
            # Prompt/expert changes are not reflected in solution_version; use config_version so Agent re-syncs.
            current_ver = f"{sol_instance.solution_version}:{sol_instance.config_version}"
            if known_ver != current_ver:
                template_meta = sol_instance.template_meta if isinstance(sol_instance.template_meta, dict) else {}
                solutions.append({
                    "id": sol_instance.id,
                    "solution_id": sol_instance.solution_id,
                    "solution_version": sol_instance.solution_version,
                    "display_name": sol_instance.display_name,
                    "description": template_meta.get("description", "") if isinstance(template_meta.get("description", ""), str) else "",
                    "icon": template_meta.get("icon", "") if isinstance(template_meta.get("icon", ""), str) else "",
                    "tags": [tag for tag in template_meta.get("tags", []) if isinstance(tag, str)] if isinstance(template_meta.get("tags", []), list) else [],
                    "status": sol_instance.status,
                    "config_version": sol_instance.config_version,
                    "expert_employee_ids": sol_instance.expert_employee_ids,
                    "coordinator_employee_id": sol_instance.coordinator_employee_id,
                    "coordinator_instructions": sol_instance.coordinator_instructions or "",
                    "workflow_skill_ref": sol_instance.workflow_skill_ref,
                    "output_requirements": sol_instance.output_requirements or "",
                })

        revoked_ids = [
            rid for rid in req.known_versions
            if (rid not in authorized_employee_ids and rid not in authorized_solution_ids)
            or (rid not in all_employee_ids and rid not in all_solution_ids)
        ]

        # Packages are catalog truth, not configuration deltas: unchanged employee
        # versions must still receive a newly published catalog version.
        skill_packages = self._resolve_skill_packages(
            ctx, [cfg.model_dump(mode="json") for cfg in authorized_configs]
        )

        return AuthorizedConfigPullResponse(
            experts=experts, solutions=solutions, revoked_ids=revoked_ids,
            skill_packages=skill_packages,
            skill_packages_authoritative=self._capability is not None and self._skill_signer is not None,
            skill_signing_keys=self._skill_signer.public_metadata() if self._skill_signer is not None else [],
        )

    def _resolve_skill_packages(self, ctx: TenantContext, experts: list[dict]) -> list[SignedSkillPackage]:
        """按 experts[].skills 的 skill_id 集合，从 Manager capability_catalog 解析技能包真相。

        没配 capability_catalog 或专用 signer（D14 降级/本地测试）→ 返回 []，由响应的
        skill_packages_authoritative=false 明确表示 Agent 保持既有缓存，不阻断 sync。
        仅 Manager 有记录的 skill_id 返回技能包——不泄漏未授权技能。
        """
        from .custom_skill_package import catalog_package

        # Missing signing configuration is an intentional fail-closed downgrade:
        # never send a package that the Agent would have to treat as unsigned.
        if self._capability is None or self._skill_signer is None:
            return []
        skill_ids: list[str] = []
        seen: set[str] = set()
        for cfg in experts or []:
            for sid in cfg.get("skills", []) if isinstance(cfg.get("skills"), list) else []:
                if isinstance(sid, str) and sid and sid not in seen:
                    seen.add(sid)
                    skill_ids.append(sid)
        if not skill_ids:
            return []
        packages: list[SignedSkillPackage] = []
        resolved: set[tuple[str, str]] = set()
        for ref in skill_ids:
            sid, separator, requested_version = ref.partition("@")
            out = self._capability_get(ctx, skill_id=sid)
            if out is None or out.skill_id != sid or (separator and out.version != requested_version):
                continue
            if (out.skill_id, out.version) in resolved:
                continue
            try:
                if out.binding_policy == "disabled" or getattr(out, "package_status", "invalid") != "ready":
                    continue
                raw_files = out.files
                if not isinstance(raw_files, list):
                    continue
                files = [
                    item.model_dump(mode="json") if hasattr(item, "model_dump") else item
                    for item in raw_files
                ]
                if any(not isinstance(item, dict) for item in files):
                    continue
                pkg = catalog_package(
                    skill_id=out.skill_id, version=out.version, content_hash=out.content_hash,
                    display_name=out.display_name,
                    files=files,
                )
                if not out.content_hash:
                    continue
                packages.append(self._skill_signer.sign(pkg, tenant_id=ctx.tenant_id, member_id=ctx.user_id))
                resolved.add((out.skill_id, out.version))
            except (TypeError, ValueError):
                # Legacy catalog rows without SKILL.md are not executable packages;
                # skip them while preserving the rest of the authorized config.
                continue
        return packages

    def _capability_get(self, ctx: TenantContext, skill_id: str):
        """取 catalog 规则条目；找不到或未配返回 None。"""
        if self._capability is None:
            return None
        repo = getattr(self._capability, "_repo", None)
        if repo is None or not hasattr(repo, "get_skill_by_skill_id"):
            return None
        row = repo.get_skill_by_skill_id(ctx, skill_id=skill_id)
        if row is None:
            return None
        return _catalog_row_to_out(row)

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
