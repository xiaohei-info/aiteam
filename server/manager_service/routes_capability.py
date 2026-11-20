"""技能/连接器/记忆策略 目录北向路由（M4，02 §10.1/§10.3 + 04 §6.6，D17/D16/D22）。

路径：/api/manager/skills|connectors|memory-policies/*。受保护端点（require_claims）；
目录写操作需 owner/enterprise_admin（03 §9.7）。统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。
tenant_id 经 TenantContext（D22）。

红线（issue #38）：仅管理面真相 CRUD，不实现执行（技能执行/连接器对外调用/记忆读写归用户端）。

verifier 注入：照 build_employee_router 模式，由 app 闭包注入避免依赖 app.state 时序。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import ValidationError
from starlette.datastructures import UploadFile

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError, ValidationProblem
from shared.skill_import import MAX_ARCHIVE_ENTRIES

from .capability_origin import app_enterprise_namespace, skill_origin
from .capability_catalog_repository import CapabilityCatalogRepository
from .capability_catalog_service import (
    CapabilityCatalogService,
    build_capability_catalog_service,
)
from .enterprise_audit_repository import build_enterprise_audit_repository
from .schemas import (
    ConnectorCatalogIn,
    ConnectorCatalogOut,
    MemoryPolicyCatalogIn,
    MemoryPolicyCatalogOut,
    SkillCatalogIn,
    SkillCatalogOut,
    SkillImportJsonIn,
    SkillImportOut,
)
from .skill_import_service import ImportRequest, SkillImportService

# 导入请求体上限：技能包 10 MiB + multipart 开销（design 2026-11-20 §4.3；app 以 BodyLimit 在读体前拦截）。
SKILL_IMPORT_MAX_BODY_BYTES = 12 * 1024 * 1024
_UPLOAD_SOURCES = ("folder", "zip", "file", "editor")
_IMPORT_FORM_SCHEMA = {
    "type": "object",
    "required": ["source", "files"],
    "properties": {
        "source": {"type": "string", "enum": list(_UPLOAD_SOURCES), "description": "folder 上传文件夹；zip 上传一个压缩包；file 上传一个 .md；editor 控制台 SKILL.md 编辑器写的文件（同文件夹）。"},
        "files": {"type": "array", "items": {"type": "string", "format": "binary"}, "description": "上传的文件；文件夹上传每个文件一项。"},
        "paths": {"type": "array", "items": {"type": "string"}, "description": "与 files 一一对应的相对路径（文件夹上传用 webkitRelativePath）；缺省用文件名。"},
        "roots": {"type": "array", "items": {"type": "string"}, "description": "安装时勾选的技能根目录；缺省安装全部可用技能。"},
        "visibility": {"type": "string", "enum": ["private", "tenant", "public"], "description": "新建条目的可见范围。"},
        "binding_policy": {"type": "string", "enum": ["opt_in", "auto_bind", "disabled"], "description": "新建条目的绑定策略。"},
        "install_policy": {"type": "string", "enum": ["on_demand", "pre_install", "pinned"], "description": "新建条目的安装策略。"},
    },
}
_IMPORT_REQUEST_BODY = {
    "requestBody": {
        "required": True,
        "description": "JSON（text / url / clawhub）或 multipart/form-data（folder / zip / file）；请求体最大 12 MiB，技能包最多 256 个文件、共 10 MiB。",
        "x-max-body-bytes": SKILL_IMPORT_MAX_BODY_BYTES,
        "content": {
            "application/json": {"schema": SkillImportJsonIn.model_json_schema()},
            "multipart/form-data": {"schema": _IMPORT_FORM_SCHEMA},
        },
    },
}


def _import_service(request: Request) -> SkillImportService:
    injected = getattr(request.app.state, "_skill_import_service", None)
    if injected is not None:
        return injected
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    router = PgTenantRouter(dsn)
    service = SkillImportService(CapabilityCatalogRepository(router), audit=build_enterprise_audit_repository(router))
    request.app.state._skill_import_service = service
    return service


async def _read_import(request: Request) -> tuple[ImportRequest, SkillImportJsonIn]:
    """multipart（上传）或 JSON（粘贴 / 网址 / ClawHub）→ 统一的导入请求。"""
    try:
        if request.headers.get("content-type", "").startswith("multipart/form-data"):
            form = await request.form(max_files=MAX_ARCHIVE_ENTRIES, max_fields=MAX_ARCHIVE_ENTRIES * 2 + 16)
            uploads = [item for item in form.getlist("files") if isinstance(item, UploadFile)]
            paths = [str(item) for item in form.getlist("paths")]
            if paths and len(paths) != len(uploads):
                raise ValidationProblem("paths 必须与 files 一一对应")
            roots = [str(item) for item in form.getlist("roots")]
            options = SkillImportJsonIn.model_validate({
                "source": form.get("source"), "roots": roots or None,
                **{key: form[key] for key in ("visibility", "binding_policy", "install_policy", "fork_of") if form.get(key)},
            })
            if options.source not in _UPLOAD_SOURCES:
                raise ValidationProblem("multipart 只用于 folder / zip / file / editor 来源")
            if options.fork_of and options.source != "editor":
                raise ValidationProblem("fork_of 只用于在线编辑")
            entries = [(paths[i] if paths else (upload.filename or ""), await upload.read()) for i, upload in enumerate(uploads)]
            return ImportRequest(source=options.source, entries=entries, roots=options.roots, fork_of=options.fork_of or ""), options
        options = SkillImportJsonIn.model_validate(await request.json())
    except ValidationError as exc:
        raise ValidationProblem("导入请求格式不对：" + "; ".join(err["msg"] for err in exc.errors()[:3])) from exc
    except ValueError as exc:  # malformed JSON / multipart
        raise ValidationProblem("导入请求体无法解析") from exc
    if options.source in _UPLOAD_SOURCES:
        raise ValidationProblem("文件夹、压缩包和 .md 文件请用 multipart/form-data 上传")
    if options.fork_of:
        raise ValidationProblem("fork_of 只用于在线编辑")
    return ImportRequest(source=options.source, text=options.text, url=options.url, roots=options.roots), options


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _with_origin(request: Request, ctx, rows: list[SkillCatalogOut]) -> list[SkillCatalogOut]:
    """Adds the display namespace / provenance (design「技能MCP命名空间出处与更新提示」§4.1)."""
    enterprise = app_enterprise_namespace(request.app)(ctx) if rows else ""
    out = []
    for row in rows:
        origin = skill_origin(row.config, skill_id=row.skill_id, enterprise=enterprise)
        out.append(row.model_copy(update={"namespace": origin["namespace"], "provenance": origin["provenance"]}))
    return out


def _service(request: Request) -> CapabilityCatalogService:
    """从端配置构造 CapabilityCatalogService；未配置业务 DB → 503（不静默，与 employee 路由一致）。"""
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_capability_catalog_service", None)
    if cache is None:
        cache = build_capability_catalog_service(PgTenantRouter(dsn))
        request.app.state._capability_catalog_service = cache
    return cache


def build_capability_router(verifier) -> APIRouter:
    """构造能力目录三组路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager", tags=["manager", "capability-catalog"])
    require = require_claims(verifier)

    # ---- skill 目录（/api/manager/skills/*）----

    @router.post(
        "/skills", description="建技能目录条目（runtime 中立，D16）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建技能目录条目（runtime 中立，D16）",
        operation_id="manager_skill_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_skill(
        body: SkillCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        return Envelope[SkillCatalogOut](data=svc.create_skill(tenant_context_from(claims), body))

    @router.post(
        "/skills/import/preview", summary="检查要导入的技能",
        description="从上传的文件夹 / 压缩包 / .md、粘贴的 SKILL.md、公开 https 网址或 ClawHub 读取技能，校验后返回将导入的文件、跳过的文件、同名情况与 ClawHub 安全扫描结论；不写库。仅 owner / enterprise_admin。",
        operation_id="manager_skill_import_preview", openapi_extra=_IMPORT_REQUEST_BODY,
    )
    async def preview_skill_import(request: Request, claims: TokenClaims = Depends(require)) -> Envelope[SkillImportOut]:
        req, _options = await _read_import(request)
        data = await run_in_threadpool(_import_service(request).preview, tenant_context_from(claims), req)
        return Envelope[SkillImportOut](data=SkillImportOut.model_validate(data))

    @router.post(
        "/skills/import", summary="导入技能到企业目录",
        description="按预览勾选的技能写入企业技能目录：新名称新建条目，同名内容不同则升新版本（保留原可见范围与策略），内容相同记为重复；逐个返回结果并写审计（不含文件内容）。仅 owner / enterprise_admin。",
        operation_id="manager_skill_import", openapi_extra=_IMPORT_REQUEST_BODY,
    )
    async def import_skill(request: Request, claims: TokenClaims = Depends(require)) -> Envelope[SkillImportOut]:
        req, options = await _read_import(request)
        data = await run_in_threadpool(
            _import_service(request).install, tenant_context_from(claims), req,
            visibility=options.visibility, binding_policy=options.binding_policy, install_policy=options.install_policy,
        )
        return Envelope[SkillImportOut](data=SkillImportOut.model_validate(data))

    @router.get("/skills", description="列本租户所有技能目录条目。", summary="列本租户技能目录", operation_id="manager_skill_catalog_list")
    async def list_skills(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SkillCatalogOut]:
        svc = _service(request)
        ctx = tenant_context_from(claims)
        return ListEnvelope[SkillCatalogOut](data=_with_origin(request, ctx, svc.list_skills(ctx)))

    @router.get("/skills/{catalog_id}", description="取单个技能目录条目。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个技能目录条目", operation_id="manager_skill_catalog_get")
    async def get_skill(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        ctx = tenant_context_from(claims)
        return Envelope[SkillCatalogOut](data=_with_origin(request, ctx, [svc.get_skill(ctx, catalog_id=catalog_id)])[0])

    @router.put(
        "/skills/{catalog_id}", description="改写技能目录条目（catalog_version 自增）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写技能目录条目（catalog_version 自增）",
        operation_id="manager_skill_catalog_update",
    )
    async def update_skill(
        catalog_id: str, body: SkillCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SkillCatalogOut]:
        svc = _service(request)
        return Envelope[SkillCatalogOut](
            data=svc.update_skill(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/skills/{catalog_id}", description="删技能目录条目。删除后不可恢复。", summary="删技能目录条目",
        operation_id="manager_skill_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_skill(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_skill(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ---- connector 目录（/api/manager/connectors/*）----

    @router.post(
        "/connectors", description="建连接器目录条目（凭据本体归 M5，D18）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建连接器目录条目（凭据本体归 M5，D18）",
        operation_id="manager_connector_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_connector(
        body: ConnectorCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.create_connector(tenant_context_from(claims), body)
        )

    @router.get("/connectors", description="列本租户所有连接器目录。", summary="列本租户连接器目录", operation_id="manager_connector_catalog_list")
    async def list_connectors(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[ConnectorCatalogOut]:
        svc = _service(request)
        return ListEnvelope[ConnectorCatalogOut](data=svc.list_connectors(tenant_context_from(claims)))

    @router.get(
        "/connectors/{catalog_id}", description="取单个连接器目录条目。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个连接器目录条目",
        operation_id="manager_connector_catalog_get",
    )
    async def get_connector(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.get_connector(tenant_context_from(claims), catalog_id=catalog_id)
        )

    @router.put(
        "/connectors/{catalog_id}", description="改写连接器目录条目（catalog_version 自增）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写连接器目录条目（catalog_version 自增）",
        operation_id="manager_connector_catalog_update",
    )
    async def update_connector(
        catalog_id: str, body: ConnectorCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ConnectorCatalogOut]:
        svc = _service(request)
        return Envelope[ConnectorCatalogOut](
            data=svc.update_connector(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/connectors/{catalog_id}", description="删连接器目录条目。", summary="删连接器目录条目",
        operation_id="manager_connector_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_connector(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_connector(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # ---- memory_policy 目录（/api/manager/memory-policies/*，D17）----

    @router.post(
        "/memory-policies", description="建记忆策略目录条目（复用 mem0，D17）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="建记忆策略目录条目（复用 mem0，D17）",
        operation_id="manager_memory_policy_catalog_create", status_code=status.HTTP_201_CREATED,
    )
    async def create_memory_policy(
        body: MemoryPolicyCatalogIn, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.create_memory_policy(tenant_context_from(claims), body)
        )

    @router.get(
        "/memory-policies", description="列本租户所有记忆策略目录。", summary="列本租户记忆策略目录",
        operation_id="manager_memory_policy_catalog_list",
    )
    async def list_memory_policies(
        request: Request, claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return ListEnvelope[MemoryPolicyCatalogOut](
            data=svc.list_memory_policies(tenant_context_from(claims))
        )

    @router.get(
        "/memory-policies/{catalog_id}", description="取单个记忆策略目录条目。成功响应遵循统一 envelope，失败返回 problem+json。", summary="取单个记忆策略目录条目",
        operation_id="manager_memory_policy_catalog_get",
    )
    async def get_memory_policy(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.get_memory_policy(tenant_context_from(claims), catalog_id=catalog_id)
        )

    @router.put(
        "/memory-policies/{catalog_id}", description="改写记忆策略目录条目（catalog_version 自增）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改写记忆策略目录条目（catalog_version 自增）",
        operation_id="manager_memory_policy_catalog_update",
    )
    async def update_memory_policy(
        catalog_id: str, body: MemoryPolicyCatalogIn, request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[MemoryPolicyCatalogOut]:
        svc = _service(request)
        return Envelope[MemoryPolicyCatalogOut](
            data=svc.update_memory_policy(tenant_context_from(claims), body, catalog_id=catalog_id)
        )

    @router.delete(
        "/memory-policies/{catalog_id}", description="删记忆策略条目。", summary="删记忆策略目录条目",
        operation_id="manager_memory_policy_catalog_delete", status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_memory_policy(
        catalog_id: str, request: Request, claims: TokenClaims = Depends(require),
    ) -> Response:
        svc = _service(request)
        svc.delete_memory_policy(tenant_context_from(claims), catalog_id=catalog_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
