"""R7 复制专家：以源专家为模板，在同一事务里生成一个企业自建（origin=copied）的新专家。

复制：配置行、当前 prompt 版本、技能 / 知识 / 连接器绑定、记忆策略、头像文件。
不复制：成员授权（复制品默认无人可用）、个人记忆内容、来源模板关系（复制品不占「同模板只招一次」名额）。
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound, ValidationProblem

from .catalog_scope_reconciler import TemplateOutOfScopeConflict, is_scope_blocked
from .idempotency_repository import normalize_idempotency_key, request_fingerprint
from .recruit_model_guard import validate_recruit_model
from .schemas import RecruitModelPolicy

logger = logging.getLogger(__name__)

_NON_SLUG = re.compile(r"[^a-z0-9\s-]")
_SPACER = re.compile(r"[\s-]+")


@dataclass(frozen=True)
class CopyRepositories:
    employees: Any
    prompts: Any
    skills: Any
    knowledge: Any
    connectors: Any
    memory: Any


class EmployeeCopyService:
    def __init__(
        self, *, employees, idempotency, repositories: Callable[[Any], CopyRepositories],
        operator, avatars, config_service,
    ):
        self._employees = employees
        self._idempotency = idempotency
        self._repositories = repositories
        self._operator = operator
        self._avatars = avatars
        self._config = config_service

    def copy(
        self, ctx: TenantContext, *, source_id: str, display_name: str,
        model_policy: RecruitModelPolicy | None, idempotency_key: str,
    ):
        key = normalize_idempotency_key(idempotency_key)
        name = display_name.strip()
        if not name:
            raise ValidationProblem("display_name is required")
        source = self._employees.get(ctx, employee_id=source_id)
        if source is None:
            raise NotFound("employee not found in this tenant")
        if is_scope_blocked(source):
            raise TemplateOutOfScopeConflict("the source expert is no longer within the published scope")
        policy = model_policy or RecruitModelPolicy(
            provider_ref=source.provider_ref or "", model=source.model or "", thinking_level=source.thinking_level,
        )
        ref = validate_recruit_model(self._operator, ctx, policy) if self._operator is not None else source.platform_model_ref
        fingerprint = request_fingerprint(
            "employee-copy",
            {"source": source_id, "display_name": name,
             "model_policy": model_policy.model_dump() if model_policy else None},
        )
        result = self._idempotency.execute(
            ctx, operation="employee-copy", idempotency_key=key, request_fingerprint=fingerprint,
            status_code=201, effect=lambda session: self._create(ctx, session, source, name, policy, ref),
        )
        new_id = result.payload["employee_id"]
        if not result.replayed:
            try:
                self._avatars.copy(ctx, source_id=source_id, target_id=new_id)
            except Exception:  # 头像是文件操作，无法随数据库回滚；失败不影响复制本身
                logger.warning("copy avatar failed: source=%s target=%s", source_id, new_id, exc_info=True)
        return self._config.get(ctx, employee_id=new_id)

    def _create(self, ctx, session, source, name: str, policy: RecruitModelPolicy, ref: dict | None) -> dict:
        repos = self._repositories(session)
        memory = repos.memory.get(ctx, employee_id=source.employee_id)
        row = repos.employees.create(
            ctx,
            employee_slug=_unique_slug(repos.employees, ctx, name),
            display_name=name, persona=source.persona,
            model=policy.model or None, provider_ref=policy.provider_ref or None,
            thinking_level=policy.thinking_level, timeout_seconds=source.timeout_seconds,
            tools=list(source.tools), skills=list(source.skills),
            knowledge_refs=[], connector_refs=list(source.connector_refs),
            memory_policy=memory.policy if memory is not None else source.memory_policy,
            source_template_id=None, source_template_version=None, platform_model_ref=ref,
            department_ids=list(source.department_ids), role_title=source.role_title,
            origin="copied", copied_from_employee_id=source.employee_id,
        )
        new_id = row.employee_id
        prompt = repos.prompts.get_current(ctx, employee_id=source.employee_id)
        if prompt is not None:
            repos.prompts.create(
                ctx, employee_id=new_id, display_name=name, persona=prompt.persona,
                model=policy.model or None, provider_ref=policy.provider_ref or None,
                thinking_level=policy.thinking_level, tools=list(prompt.tools), is_current=True,
                change_note=f"复制自「{source.display_name}」",
            )
        for b in repos.skills.list_all(ctx, employee_id=source.employee_id):
            repos.skills.create(ctx, employee_id=new_id, skill_id=b.skill_id, enabled=b.enabled, config=dict(b.config))
        for b in repos.knowledge.list_all(ctx, employee_id=source.employee_id):
            if b.revoked_at is None:
                repos.knowledge.create(ctx, employee_id=new_id, knowledge_space_id=b.knowledge_space_id,
                                       enabled=b.enabled, config=dict(b.config))
        for b in repos.connectors.list_all(ctx, employee_id=source.employee_id):
            repos.connectors.create(ctx, employee_id=new_id, connector_id=b.connector_id, grant_ref=b.grant_ref,
                                    enabled=b.enabled, config=dict(b.config))
        return {"employee_id": new_id}


def _unique_slug(employees, ctx, name: str) -> str:
    base = _SPACER.sub("_", _NON_SLUG.sub("", name.lower())).strip("_")[:56] or f"expert_{uuid.uuid4().hex[:8]}"
    candidate = base
    for i in range(1, 51):
        if employees.get_by_slug(ctx, employee_slug=candidate) is None:
            return candidate
        candidate = f"{base}_{i}"
    return f"{base}_{uuid.uuid4().hex[:7]}"


def build_employee_copy_service(router, operator, avatars, config_service) -> EmployeeCopyService:
    from .employee_bindings_repositories import (
        EmployeeConnectorBindingRepository, EmployeeKnowledgeBindingRepository, EmployeeMemorySettingRepository,
        EmployeePromptVersionRepository, EmployeeSkillBindingRepository,
    )
    from .employee_config_repository import EmployeeConfigRepository
    from .idempotency_repository import ManagerIdempotencyRepository
    from .recruit_transaction import _TransactionRouter

    def repositories(session) -> CopyRepositories:
        bound = _TransactionRouter(session)
        return CopyRepositories(
            employees=EmployeeConfigRepository(bound), prompts=EmployeePromptVersionRepository(bound),
            skills=EmployeeSkillBindingRepository(bound), knowledge=EmployeeKnowledgeBindingRepository(bound),
            connectors=EmployeeConnectorBindingRepository(bound), memory=EmployeeMemorySettingRepository(bound),
        )

    return EmployeeCopyService(
        employees=EmployeeConfigRepository(router), idempotency=ManagerIdempotencyRepository(router),
        repositories=repositories, operator=operator, avatars=avatars, config_service=config_service,
    )
