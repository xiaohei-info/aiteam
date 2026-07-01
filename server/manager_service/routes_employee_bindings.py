"""employee 独立绑定实体 北向路由（issue AITEAM-234 / GitHub AITEAM-280，02 §10/03 §9.7/04 §6）。

路径挂载在现有 /api/employees 路由之下：
    /api/manager/employees/{employee_id}/prompt-versions
    /api/manager/employees/{employee_id}/skill-bindings
    /api/manager/employees/{employee_id}/knowledge-bindings
    /api/manager/employees/{employee_id}/memory-setting
    /api/manager/employees/{employee_id}/connector-bindings

受保护端点（require_claims）；写操作需 owner/enterprise_admin（service 层强制，03 §9.7）。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22），不手写过滤。
verifier 注入：与 routes_employee 一致，由 app 持有并闭包注入各受保护端点，避免依赖 app.state 时序。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path, Query, Request, status
from fastapi.responses import Response

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .employee_bindings_services import (
    build_connector_binding_service,
    build_knowledge_binding_service,
    build_memory_setting_service,
    build_prompt_version_service,
    build_skill_binding_service,
    EmployeeConnectorBindingService,
    EmployeeKnowledgeBindingService,
    EmployeeMemorySettingService,
    EmployeePromptVersionService,
    EmployeeSkillBindingService,
)
from .schemas_employee_bindings import (
    ConnectorBindingCreate,
    ConnectorBindingOut,
    ConnectorBindingPatch,
    KnowledgeBindingCreate,
    KnowledgeBindingOut,
    KnowledgeBindingPatch,
    MemorySettingIn,
    MemorySettingOut,
    PromptVersionCreate,
    PromptVersionOut,
    SkillBindingCreate,
    SkillBindingOut,
    SkillBindingPatch,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"



# ---------------- Prompt Versions ----------------

def _build_prompt_versions_router(verifier) -> APIRouter:
    require = require_claims(verifier)

    def svc(request: Request):
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        cache = getattr(request.app.state, "_emp_bind_svc_pv", None)
        if cache is None:
            cache = build_prompt_version_service(PgTenantRouter(dsn))
            setattr(request.app.state, "_emp_bind_svc_pv", cache)
        return cache

    router = APIRouter(prefix="/api/manager/employees/{employee_id}/prompt-versions",
                       tags=["manager", "employee-bindings"])

    @router.post("", summary="新建 employee prompt 版本",
                 operation_id="manager_employee_prompt_version_create",
                 status_code=status.HTTP_201_CREATED)
    async def create_prompt_version(
        body: PromptVersionCreate,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[PromptVersionOut]:
        s = svc(request)
        out = s.create(tenant_context_from(claims), employee_id=employee_id,
                       display_name=body.display_name, persona=body.persona,
                       model=body.model, provider_ref=body.provider_ref,
                       thinking_level=body.thinking_level, tools=body.tools,
                       set_current=body.set_current, change_note=body.change_note)
        return Envelope(data=PromptVersionOut(**out))

    @router.get("", summary="列 employee 全部 prompt 版本",
                operation_id="manager_employee_prompt_version_list")
    async def list_prompt_versions(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[PromptVersionOut]:
        s = svc(request)
        items = s.list_all(tenant_context_from(claims), employee_id=employee_id)
        return ListEnvelope(data=[PromptVersionOut(**i) for i in items])

    @router.get("/current", summary="取当前生效 prompt 版本",
                operation_id="manager_employee_prompt_version_get_current")
    async def get_current_prompt_version(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[PromptVersionOut]:
        s = svc(request)
        return Envelope(data=PromptVersionOut(
            **s.get_current(tenant_context_from(claims), employee_id=employee_id)))

    @router.get("/{binding_id}", summary="取单个 prompt 版本",
                operation_id="manager_employee_prompt_version_get")
    async def get_prompt_version(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[PromptVersionOut]:
        s = svc(request)
        return Envelope(data=PromptVersionOut(
            **s.get(tenant_context_from(claims), binding_id=binding_id)))

    @router.post("/{binding_id}/activate", summary="把指定 prompt 版设为当前生效",
                 operation_id="manager_employee_prompt_version_activate")
    async def activate_prompt_version(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[PromptVersionOut]:
        s = svc(request)
        return Envelope(data=PromptVersionOut(
            **s.set_current(tenant_context_from(claims), binding_id=binding_id)))

    @router.delete("/{binding_id}", summary="删除 prompt 版本",
                   operation_id="manager_employee_prompt_version_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_prompt_version(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        s = svc(request)
        s.delete(tenant_context_from(claims), binding_id=binding_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


# ---------------- Skill Bindings ----------------

def _build_skill_bindings_router(verifier) -> APIRouter:
    require = require_claims(verifier)

    def svc(request: Request):
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        cache = getattr(request.app.state, "_emp_bind_svc_sk", None)
        if cache is None:
            cache = build_skill_binding_service(PgTenantRouter(dsn))
            setattr(request.app.state, "_emp_bind_svc_sk", cache)
        return cache

    router = APIRouter(prefix="/api/manager/employees/{employee_id}/skill-bindings",
                       tags=["manager", "employee-bindings"])

    @router.post("", summary="新增 employee ↔ skill 绑定", operation_id="manager_employee_skill_bind",
                 status_code=status.HTTP_201_CREATED)
    async def create_skill_binding(
        body: SkillBindingCreate,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillBindingOut]:
        s = svc(request)
        out = s.create(tenant_context_from(claims), employee_id=employee_id,
                       skill_id=body.skill_id, enabled=body.enabled, config=body.config)
        return Envelope(data=SkillBindingOut(**out))

    @router.get("", summary="列 employee 全部 skill 绑定",
                operation_id="manager_employee_skill_bind_list")
    async def list_skill_bindings(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SkillBindingOut]:
        s = svc(request)
        items = s.list_all(tenant_context_from(claims), employee_id=employee_id)
        return ListEnvelope(data=[SkillBindingOut(**i) for i in items])

    @router.get("/{binding_id}", summary="取单个 skill 绑定",
                operation_id="manager_employee_skill_bind_get")
    async def get_skill_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillBindingOut]:
        s = svc(request)
        return Envelope(data=SkillBindingOut(
            **s.get(tenant_context_from(claims), binding_id=binding_id)))

    @router.patch("/{binding_id}", summary="改 skill 绑定（enabled/config）",
                  operation_id="manager_employee_skill_bind_patch")
    async def patch_skill_binding(
        body: SkillBindingPatch,
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillBindingOut]:
        s = svc(request)
        return Envelope(data=SkillBindingOut(
            **s.update(tenant_context_from(claims), binding_id=binding_id,
                      enabled=body.enabled, config=body.config)))

    @router.delete("/{binding_id}", summary="删 skill 绑定",
                   operation_id="manager_employee_skill_bind_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_skill_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        s = svc(request)
        s.delete(tenant_context_from(claims), binding_id=binding_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


# ---------------- Knowledge Bindings ----------------

def _build_knowledge_bindings_router(verifier) -> APIRouter:
    require = require_claims(verifier)

    def svc(request: Request):
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        cache = getattr(request.app.state, "_emp_bind_svc_kn", None)
        if cache is None:
            cache = build_knowledge_binding_service(PgTenantRouter(dsn))
            setattr(request.app.state, "_emp_bind_svc_kn", cache)
        return cache

    router = APIRouter(prefix="/api/manager/employees/{employee_id}/knowledge-bindings",
                       tags=["manager", "employee-bindings"])

    @router.post("", summary="新增 employee ↔ knowledge_space 绑定",
                 operation_id="manager_employee_knowledge_bind", status_code=status.HTTP_201_CREATED)
    async def create_knowledge_binding(
        body: KnowledgeBindingCreate,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeBindingOut]:
        s = svc(request)
        out = s.create(tenant_context_from(claims), employee_id=employee_id,
                       knowledge_space_id=body.knowledge_space_id, enabled=body.enabled,
                       config=body.config)
        return Envelope(data=KnowledgeBindingOut(**out))

    @router.get("", summary="列 employee 全部 knowledge 绑定",
                operation_id="manager_employee_knowledge_bind_list")
    async def list_knowledge_bindings(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[KnowledgeBindingOut]:
        s = svc(request)
        items = s.list_all(tenant_context_from(claims), employee_id=employee_id)
        return ListEnvelope(data=[KnowledgeBindingOut(**i) for i in items])

    @router.get("/{binding_id}", summary="取单个 knowledge 绑定",
                operation_id="manager_employee_knowledge_bind_get")
    async def get_knowledge_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeBindingOut]:
        s = svc(request)
        return Envelope(data=KnowledgeBindingOut(
            **s.get(tenant_context_from(claims), binding_id=binding_id)))

    @router.patch("/{binding_id}", summary="改 knowledge 绑定（enabled/config）",
                  operation_id="manager_employee_knowledge_bind_patch")
    async def patch_knowledge_binding(
        body: KnowledgeBindingPatch,
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[KnowledgeBindingOut]:
        s = svc(request)
        return Envelope(data=KnowledgeBindingOut(
            **s.update(tenant_context_from(claims), binding_id=binding_id,
                      enabled=body.enabled, config=body.config)))

    @router.delete("/{binding_id}", summary="删 knowledge 绑定",
                   operation_id="manager_employee_knowledge_bind_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_knowledge_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        s = svc(request)
        s.delete(tenant_context_from(claims), binding_id=binding_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


# ---------------- Memory Setting (1:1) ----------------

def _build_memory_setting_router(verifier) -> APIRouter:
    require = require_claims(verifier)

    def svc(request: Request):
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        cache = getattr(request.app.state, "_emp_bind_svc_mem", None)
        if cache is None:
            cache = build_memory_setting_service(PgTenantRouter(dsn))
            setattr(request.app.state, "_emp_bind_svc_mem", cache)
        return cache

    router = APIRouter(prefix="/api/manager/employees/{employee_id}",
                       tags=["manager", "employee-bindings"])

    @router.get("/memory-setting", summary="取 employee 记忆策略单例",
                operation_id="manager_employee_memory_setting_get", include_in_schema=True)
    async def get_memory_setting(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemorySettingOut]:
        s = svc(request)
        return Envelope(data=MemorySettingOut(
            **s.get(tenant_context_from(claims), employee_id=employee_id)))

    @router.put("/memory-setting", summary="新建或全量更新 employee 记忆策略单例",
                operation_id="manager_employee_memory_setting_upsert")
    async def upsert_memory_setting(
        body: MemorySettingIn,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemorySettingOut]:
        s = svc(request)
        out = s.upsert(tenant_context_from(claims), employee_id=employee_id,
                       policy=body.policy, seed_memories=body.seed_memories,
                       retention_days=body.retention_days, scope=body.scope)
        return Envelope(data=MemorySettingOut(**out))

    @router.patch("/memory-setting", summary="局部改 employee 记忆策略单例（不存在则 404）",
                  operation_id="manager_employee_memory_setting_patch")
    async def patch_memory_setting(
        body: MemorySettingIn,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemorySettingOut]:
        s = svc(request)
        out = s.update(tenant_context_from(claims), employee_id=employee_id,
                       policy=body.policy, seed_memories=body.seed_memories,
                       retention_days=body.retention_days, scope=body.scope)
        return Envelope(data=MemorySettingOut(**out))

    @router.delete("/memory-setting", summary="删 employee 记忆策略单例",
                   operation_id="manager_employee_memory_setting_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_memory_setting(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        s = svc(request)
        s.delete(tenant_context_from(claims), employee_id=employee_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


# ---------------- Connector Bindings ----------------

def _build_connector_bindings_router(verifier) -> APIRouter:
    require = require_claims(verifier)

    def svc(request: Request):
        dsn = request.app.state.settings.db_url
        if not dsn:
            raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
        cache = getattr(request.app.state, "_emp_bind_svc_co", None)
        if cache is None:
            cache = build_connector_binding_service(PgTenantRouter(dsn))
            setattr(request.app.state, "_emp_bind_svc_co", cache)
        return cache

    router = APIRouter(prefix="/api/manager/employees/{employee_id}/connector-bindings",
                       tags=["manager", "employee-bindings"])

    @router.post("", summary="新增 employee ↔ connector 绑定",
                 operation_id="manager_employee_connector_bind", status_code=status.HTTP_201_CREATED)
    async def create_connector_binding(
        body: ConnectorBindingCreate,
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorBindingOut]:
        s = svc(request)
        out = s.create(tenant_context_from(claims), employee_id=employee_id,
                       connector_id=body.connector_id, grant_ref=body.grant_ref,
                       enabled=body.enabled, config=body.config)
        return Envelope(data=ConnectorBindingOut(**out))

    @router.get("", summary="列 employee 全部 connector 绑定",
                operation_id="manager_employee_connector_bind_list")
    async def list_connector_bindings(
        employee_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[ConnectorBindingOut]:
        s = svc(request)
        items = s.list_all(tenant_context_from(claims), employee_id=employee_id)
        return ListEnvelope(data=[ConnectorBindingOut(**i) for i in items])

    @router.get("/{binding_id}", summary="取单个 connector 绑定",
                operation_id="manager_employee_connector_bind_get")
    async def get_connector_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorBindingOut]:
        s = svc(request)
        return Envelope(data=ConnectorBindingOut(
            **s.get(tenant_context_from(claims), binding_id=binding_id)))

    @router.patch("/{binding_id}", summary="改 connector 绑定（grant_ref/enabled/config）",
                  operation_id="manager_employee_connector_bind_patch")
    async def patch_connector_binding(
        body: ConnectorBindingPatch,
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorBindingOut]:
        s = svc(request)
        return Envelope(data=ConnectorBindingOut(
            **s.update(tenant_context_from(claims), binding_id=binding_id,
                      grant_ref=body.grant_ref, enabled=body.enabled, config=body.config)))

    @router.delete("/{binding_id}", summary="删 connector 绑定",
                   operation_id="manager_employee_connector_bind_delete",
                   status_code=status.HTTP_204_NO_CONTENT)
    async def delete_connector_binding(
        employee_id: str = Path(...),
        binding_id: str = Path(...),
        request: Request = None,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        s = svc(request)
        s.delete(tenant_context_from(claims), binding_id=binding_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router


def build_employee_bindings_router(verifier) -> APIRouter:
    """构造聚合路由：把 5 组独立绑定实体子路由挂在 /api/manager/employees/{employee_id}/... 下。

    FastAPI 按路径模板精确匹配；记忆单例的 /memory-setting 与 prompt-versions/{binding_id}
    等多段路径不会和现有 /{employee_id} GET/PUT/DELETE 冲突（段数不同）。
    """
    root = APIRouter(tags=["manager", "employee-bindings"])
    root.include_router(_build_prompt_versions_router(verifier))
    root.include_router(_build_skill_bindings_router(verifier))
    root.include_router(_build_knowledge_bindings_router(verifier))
    root.include_router(_build_memory_setting_router(verifier))
    root.include_router(_build_connector_bindings_router(verifier))
    return root
