"""employee 独立绑定实体 业务编排（issue AITEAM-234 / GitHub AITEAM-280，04 §6.1/§6.6）。

编排 5 个 repository（租户隔离）+ 冲突/缺失判定。tenant_id 全程经 TenantContext，
不手写过滤（D22）。写操作鉴权需 owner/enterprise_admin（03 §9.7，与 EmployeeConfigService 一致）。

独立实体边界（含已通过 existence-check 校验的入参）：
  PromptVersion  — 版本号 + 当前生效版
  SkillBinding   — 重复绑定/BadRequest
  KnowledgeBinding
  MemorySetting  — 1:1 单例 upsert
  ConnectorBinding
"""

from __future__ import annotations

from uuid import UUID

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from .knowledge_intake_repository import KnowledgeDocumentBindingRepository
from .employee_bindings_repositories import (
    EmployeeConnectorBindingRepository,
    EmployeeKnowledgeBindingRepository,
    EmployeeMemorySettingRepository,
    EmployeePromptVersionRepository,
    EmployeeSkillBindingRepository,
    PromptVersionRow,
    SkillBindingRow,
    KnowledgeBindingRow,
    MemorySettingRow,
    ConnectorBindingRow,
)


# 配置写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


def _ensure_can_write(ctx: TenantContext) -> None:
    """写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_WRITE_ROLES):
        raise Forbidden("binding write requires owner or enterprise_admin")


# ============================= PromptVersion =============================


class EmployeePromptVersionService:
    """employee prompt 版本化 CRUD 编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(self, repo: EmployeePromptVersionRepository):
        self._repo = repo

    def create(self, ctx: TenantContext, *, employee_id: str, display_name: str,
               persona: str | None, model: str | None, provider_ref: str | None,
               thinking_level: str | None, tools: list[str], set_current: bool,
               change_note: str | None) -> dict:
        _ensure_can_write(ctx)
        if set_current:
            current = self._repo.get_current(ctx, employee_id=employee_id)
            is_current = True
        else:
            is_current = False
        row = self._repo.create(
            ctx, employee_id=employee_id, display_name=display_name, persona=persona,
            model=model, provider_ref=provider_ref, thinking_level=thinking_level,
            tools=list(tools or []), is_current=is_current, change_note=change_note,
        )
        return _prompt_to_dict(row)

    def require_employee(self, ctx: TenantContext, *, binding_id: str, employee_id: str) -> None:
        if self.get(ctx, binding_id=binding_id)["employee_id"] != employee_id:
            raise NotFound("binding not found for this employee")

    def get(self, ctx: TenantContext, *, binding_id: str) -> dict:
        row = self._repo.get(ctx, binding_id=binding_id)
        if row is None:
            raise NotFound("prompt version not found in this tenant")
        return _prompt_to_dict(row)

    def get_current(self, ctx: TenantContext, *, employee_id: str) -> dict:
        row = self._repo.get_current(ctx, employee_id=employee_id)
        if row is None:
            raise NotFound("no active prompt version for this employee")
        return _prompt_to_dict(row)

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[dict]:
        return [_prompt_to_dict(r) for r in self._repo.list_all(ctx, employee_id=employee_id)]

    def set_current(self, ctx: TenantContext, *, binding_id: str) -> dict:
        _ensure_can_write(ctx)
        row = self._repo.set_current(ctx, binding_id=binding_id)
        if row is None:
            raise NotFound("prompt version not found in this tenant")
        return _prompt_to_dict(row)

    def delete(self, ctx: TenantContext, *, binding_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, binding_id=binding_id):
            raise NotFound("prompt version not found in this tenant")


def _prompt_to_dict(row: PromptVersionRow) -> dict:
    return {
        "binding_id": row.binding_id,
        "employee_id": row.employee_id,
        "version": row.version,
        "display_name": row.display_name,
        "persona": row.persona,
        "model": row.model,
        "provider_ref": row.provider_ref,
        "thinking_level": row.thinking_level,
        "tools": row.tools,
        "is_current": row.is_current,
        "change_note": row.change_note,
        "created_at": row.created_at,
    }


def build_prompt_version_service(router: PgTenantRouter) -> EmployeePromptVersionService:
    return EmployeePromptVersionService(EmployeePromptVersionRepository(router))


# ============================= SkillBinding =============================


class EmployeeSkillBindingService:
    """employee ↔ skill 绑定 CRUD 编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(self, repo: EmployeeSkillBindingRepository):
        self._repo = repo

    def create(self, ctx: TenantContext, *, employee_id: str, skill_id: str,
               enabled: bool, config: dict) -> dict:
        _ensure_can_write(ctx)
        existing = self._repo.get_by_ref(ctx, employee_id=employee_id, skill_id=skill_id)
        if existing is not None:
            raise Conflict("skill already bound to this employee")
        row = self._repo.create(ctx, employee_id=employee_id, skill_id=skill_id,
                                enabled=enabled, config=config or {})
        return _skill_to_dict(row)

    def require_employee(self, ctx: TenantContext, *, binding_id: str, employee_id: str) -> None:
        if self.get(ctx, binding_id=binding_id)["employee_id"] != employee_id:
            raise NotFound("binding not found for this employee")

    def get(self, ctx: TenantContext, *, binding_id: str) -> dict:
        row = self._repo.get(ctx, binding_id=binding_id)
        if row is None:
            raise NotFound("skill binding not found in this tenant")
        return _skill_to_dict(row)

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[dict]:
        return [_skill_to_dict(r) for r in self._repo.list_all(ctx, employee_id=employee_id)]

    def update(self, ctx: TenantContext, *, binding_id: str, enabled: bool,
               config: dict) -> dict:
        _ensure_can_write(ctx)
        row = self._repo.update(ctx, binding_id=binding_id, enabled=enabled,
                                config=config or {})
        if row is None:
            raise NotFound("skill binding not found in this tenant")
        return _skill_to_dict(row)

    def delete(self, ctx: TenantContext, *, binding_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, binding_id=binding_id):
            raise NotFound("skill binding not found in this tenant")


def _skill_to_dict(row: SkillBindingRow) -> dict:
    return {
        "binding_id": row.binding_id,
        "employee_id": row.employee_id,
        "skill_id": row.skill_id,
        "enabled": row.enabled,
        "config": row.config,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def build_skill_binding_service(router: PgTenantRouter) -> EmployeeSkillBindingService:
    return EmployeeSkillBindingService(EmployeeSkillBindingRepository(router))


# ============================= KnowledgeBinding =============================


class EmployeeKnowledgeBindingService:
    """employee ↔ knowledge_space 绑定 CRUD 编排。tenant_id 全程经 TenantContext。"""

    def __init__(self, repo: EmployeeKnowledgeBindingRepository,
                 ready_documents: KnowledgeDocumentBindingRepository | None = None):
        self._repo = repo
        self._ready_documents = ready_documents

    def create(self, ctx: TenantContext, *, employee_id: str, knowledge_space_id: str,
               enabled: bool, config: dict) -> dict:
        _ensure_can_write(ctx)
        try:
            employee_id = str(UUID(str(employee_id)))
        except (ValueError, TypeError) as exc:
            raise ValidationProblem("employee_id must be a UUID") from exc
        if not enabled:
            row, _changed = self._repo.atomic_disable(
                ctx, employee_id=employee_id, knowledge_space_id=knowledge_space_id, config=config,
            )
            if row is None:
                raise NotFound("employee not found in this tenant")
        else:
            row, changed = self._repo.atomic_enable(
                ctx, employee_id=employee_id, knowledge_space_id=knowledge_space_id, config=config,
            )
            if row is None:
                raise NotFound("employee not found in this tenant")
            if not changed:
                raise Conflict("knowledge space already bound to this employee")
        if enabled and self._ready_documents is not None:
            # Synthetic ready bindings make existing indexed documents visible
            # immediately; the SQL runs under the same TenantContext/RLS.
            self._ready_documents.backfill_ready_for_employee(
                ctx, knowledge_space_id=knowledge_space_id, employee_id=employee_id,
            )
        return _know_to_dict(row)

    def require_employee(self, ctx: TenantContext, *, binding_id: str, employee_id: str) -> None:
        if self.get(ctx, binding_id=binding_id)["employee_id"] != employee_id:
            raise NotFound("binding not found for this employee")

    def get(self, ctx: TenantContext, *, binding_id: str) -> dict:
        row = self._repo.get(ctx, binding_id=binding_id)
        if row is None:
            raise NotFound("knowledge binding not found in this tenant")
        return _know_to_dict(row)

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[dict]:
        try:
            employee_id = str(UUID(str(employee_id)))
        except (ValueError, TypeError) as exc:
            raise ValidationProblem("employee_id must be a UUID") from exc
        if not self._repo.employee_exists(ctx, employee_id=employee_id):
            raise NotFound("employee not found in this tenant")
        return [_know_to_dict(r) for r in self._repo.list_all(ctx, employee_id=employee_id)]

    def update(self, ctx: TenantContext, *, binding_id: str, enabled: bool | None,
               config: dict | None) -> dict:
        _ensure_can_write(ctx)
        row = self._repo.update(ctx, binding_id=binding_id, enabled=enabled, config=config)
        if row is None:
            raise NotFound("knowledge binding not found in this tenant")
        if enabled and self._ready_documents is not None:
            # Re-enabling an existing binding must expose documents indexed while it was disabled.
            self._ready_documents.backfill_ready_for_employee(
                ctx, knowledge_space_id=row.knowledge_space_id, employee_id=row.employee_id,
            )
        return _know_to_dict(row)

    def delete(self, ctx: TenantContext, *, binding_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, binding_id=binding_id):
            raise NotFound("knowledge binding not found in this tenant")


def _policy_metadata(row) -> dict:
    return {name: getattr(row, name) for name in (
        "policy_revision", "policy_source", "policy_actor", "policy_updated_at", "revoked_at",
    )}


def _know_to_dict(row: KnowledgeBindingRow) -> dict:
    return {
        "binding_id": row.binding_id,
        "employee_id": row.employee_id,
        "knowledge_space_id": row.knowledge_space_id,
        "enabled": row.enabled,
        "config": row.config,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        **_policy_metadata(row),
    }


class EmployeeKnowledgeDocumentBindingService:
    """Employee document exceptions, separate from whole capability and index readiness."""

    def __init__(self, repo: KnowledgeDocumentBindingRepository, employees):
        self._repo = repo
        self._employees = employees

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[dict]:
        _ensure_can_write(ctx)
        self._employees.get(ctx, employee_id=employee_id)
        return [self._out(row) for row in self._repo.list_by_employee(ctx, employee_id=employee_id)]

    def set_policy(self, ctx: TenantContext, *, employee_id: str, document_id: str,
                   enabled: bool, revoke: bool = False) -> dict:
        _ensure_can_write(ctx)
        self._employees.get(ctx, employee_id=employee_id)
        row = self._repo.set_policy(ctx, employee_id=employee_id, document_id=document_id,
                                    enabled=enabled, revoke=revoke)
        if row is None:
            raise NotFound("knowledge document not found in this enterprise")
        return self._out(row)

    @staticmethod
    def _out(row) -> dict:
        return {"employee_id": row.employee_id, "document_id": row.document_id,
                "enabled": row.enabled, "status": row.status, **_policy_metadata(row)}


def build_knowledge_document_binding_service(router: PgTenantRouter) -> EmployeeKnowledgeDocumentBindingService:
    from .employee_config_service import build_employee_config_service
    return EmployeeKnowledgeDocumentBindingService(
        KnowledgeDocumentBindingRepository(router), build_employee_config_service(router),
    )


def build_knowledge_binding_service(router: PgTenantRouter) -> EmployeeKnowledgeBindingService:
    return EmployeeKnowledgeBindingService(
        EmployeeKnowledgeBindingRepository(router), KnowledgeDocumentBindingRepository(router)
    )


# ============================= MemorySetting =============================


class EmployeeMemorySettingService:
    """employee 记忆策略单例编排（1:1 upsert）。tenant_id 全程经 TenantContext。"""

    def __init__(self, repo: EmployeeMemorySettingRepository):
        self._repo = repo

    def get(self, ctx: TenantContext, *, employee_id: str) -> dict:
        row = self._repo.get(ctx, employee_id=employee_id)
        if row is None:
            raise NotFound("memory setting not found for this employee")
        return _memory_to_dict(row)

    def upsert(self, ctx: TenantContext, *, employee_id: str, **fields) -> dict:
        _ensure_can_write(ctx)
        return _memory_to_dict(self._repo.upsert(ctx, employee_id=employee_id, **fields))

    def update(self, ctx: TenantContext, *, employee_id: str, **fields) -> dict:
        _ensure_can_write(ctx)
        row = self._repo.update(ctx, employee_id=employee_id, **fields)
        if row is None:
            raise NotFound("memory setting not found for this employee")
        return _memory_to_dict(row)

    def delete(self, ctx: TenantContext, *, employee_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, employee_id=employee_id):
            raise NotFound("memory setting not found for this employee")


def _memory_to_dict(row: MemorySettingRow) -> dict:
    return {
        "binding_id": row.binding_id,
        "employee_id": row.employee_id,
        "policy": row.policy,
        "seed_memories": row.seed_memories,
        "retention_days": row.retention_days,
        "scope": row.scope,
        "updated_at": row.updated_at,
        "revision": row.revision,
        "source": row.source,
        "explicit_auto_retain": row.explicit_auto_retain,
        "retention_status": "fact_only" if row.retention_guarded or row.retention_days is not None else "unlimited",
        "retention_guarded": row.retention_guarded,
        "provenance": row.provenance or {},
    }


def build_memory_setting_service(router: PgTenantRouter) -> EmployeeMemorySettingService:
    return EmployeeMemorySettingService(EmployeeMemorySettingRepository(router))


# ============================= ConnectorBinding =============================


class EmployeeConnectorBindingService:
    """employee ↔ connector 绑定 CRUD 编排。tenant_id 全程经 TenantContext。"""

    def __init__(self, repo: EmployeeConnectorBindingRepository):
        self._repo = repo

    def create(self, ctx: TenantContext, *, employee_id: str, connector_id: str,
               grant_ref: str | None, enabled: bool, config: dict) -> dict:
        _ensure_can_write(ctx)
        existing = self._repo.get_by_ref(ctx, employee_id=employee_id, connector_id=connector_id)
        if existing is not None:
            raise Conflict("connector already bound to this employee")
        row = self._repo.create(ctx, employee_id=employee_id, connector_id=connector_id,
                                grant_ref=grant_ref, enabled=enabled, config=config or {})
        return _conn_to_dict(row)

    def require_employee(self, ctx: TenantContext, *, binding_id: str, employee_id: str) -> None:
        if self.get(ctx, binding_id=binding_id)["employee_id"] != employee_id:
            raise NotFound("binding not found for this employee")

    def get(self, ctx: TenantContext, *, binding_id: str) -> dict:
        row = self._repo.get(ctx, binding_id=binding_id)
        if row is None:
            raise NotFound("connector binding not found in this tenant")
        return _conn_to_dict(row)

    def list_all(self, ctx: TenantContext, *, employee_id: str) -> list[dict]:
        return [_conn_to_dict(r) for r in self._repo.list_all(ctx, employee_id=employee_id)]

    def update(self, ctx: TenantContext, *, binding_id: str, grant_ref: str | None,
               enabled: bool, config: dict) -> dict:
        _ensure_can_write(ctx)
        row = self._repo.update(ctx, binding_id=binding_id, grant_ref=grant_ref,
                                enabled=enabled, config=config or {})
        if row is None:
            raise NotFound("connector binding not found in this tenant")
        return _conn_to_dict(row)

    def delete(self, ctx: TenantContext, *, binding_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, binding_id=binding_id):
            raise NotFound("connector binding not found in this tenant")


def _conn_to_dict(row: ConnectorBindingRow) -> dict:
    return {
        "binding_id": row.binding_id,
        "employee_id": row.employee_id,
        "connector_id": row.connector_id,
        "grant_ref": row.grant_ref,
        "enabled": row.enabled,
        "config": row.config,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def build_connector_binding_service(router: PgTenantRouter) -> EmployeeConnectorBindingService:
    return EmployeeConnectorBindingService(EmployeeConnectorBindingRepository(router))
