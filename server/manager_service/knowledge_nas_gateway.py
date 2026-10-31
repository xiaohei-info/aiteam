"""企业知识库部署位置 + NAS 只读网关（议题 6：企业 / 个人 / 本机三分）。

- 部署位置是企业知识库的属性：managed（Manager 托管 LightRAG）或 nas（企业内网 NAS）。
  只有 owner/enterprise_admin 可读写 endpoint / credential_ref；普通成员只见 deployment_kind。
- kind=nas 时 Manager 以 NAS 协议（AITeam docs/knowledge-base-provider.md 的只读子集：
  GET /api/knowledge-bases、GET /api/knowledge-bases/{id}/search?q=、
  GET /api/knowledge-documents/{id}/preview，Bearer token）做只读网关；客户端从不持有企业 NAS 令牌。
- 访问策略沿用企业知识库现行成员读策略：本租户已认证成员可读（RLS 隔离 tenant），写只读网关不提供。

凭据口径：credential_ref 是 Manager 进程环境变量名（MANAGER_NAS_ 前缀），值为 JSON
`{"tenant_id": ..., "endpoint": ..., "token": ...}`，由部署方逐 NAS 知识库设置。tenant_id 与
endpoint 必须与请求租户和库内 endpoint 一致，否则视为未配置——管理员不能借用别的租户的凭据，
也不能把凭据改投到任意地址（出站目标被部署方钉死）。凭据值从不入库、从不出参、从不进错误体。

数据所有权：部署配置归 Manager tenant 数据空间（knowledge_space_deployment，Manager 单写）；
NAS 内容归企业 NAS，Manager 只转发只读投影、不落库、不缓存。
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import quote, urlsplit

import httpx

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Forbidden, NotFound, ValidationProblem

from .knowledge_space_repository import KnowledgeSpaceDeploymentRow
from .schemas import (
    KnowledgeSpaceDeploymentOut,
    KnowledgeSpaceDeploymentUpdate,
    NasKnowledgeBaseOut,
    NasKnowledgeDocumentPreviewOut,
    NasKnowledgeFileOut,
    NasKnowledgeSearchHit,
    NasKnowledgeSearchOut,
)

NAS_CREDENTIAL_REF_PATTERN = re.compile(r"^MANAGER_NAS_[A-Z0-9_]{1,64}$")
_DEPLOYMENT_ADMIN_ROLES = frozenset({EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value})
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_TIMEOUT_SECONDS = 10.0


class NasUnavailable(AppError):
    status, code, title = 503, "nas_unavailable", "NAS knowledge service unavailable"


class NasCredentialUnavailable(AppError):
    status, code, title = 503, "nas_credential_unavailable", "NAS credential unavailable"


class NasResourceNotFound(AppError):
    status, code, title = 404, "nas_resource_not_found", "NAS resource not found"


class KnowledgeSpaceNotNas(AppError):
    status, code, title = 409, "knowledge_space_not_nas", "Knowledge space is not deployed on NAS"


@dataclass(frozen=True)
class NasCredential:
    endpoint: str
    token: str = field(repr=False)


def normalize_nas_endpoint(raw: str) -> str:
    """NAS 根地址：https，或本机回环 http；不得含 userinfo/query/fragment。返回去尾斜杠形式。"""
    value = raw.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ValidationProblem("endpoint must be an absolute http(s) URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValidationProblem("endpoint must not contain credentials, query or fragment")
    if parts.scheme == "http" and not _is_loopback(parts.hostname):
        raise ValidationProblem("endpoint must use https unless it is a loopback address")
    return value.rstrip("/")


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def resolve_nas_credential(
    credential_ref: str | None,
    *,
    tenant_id: str,
    endpoint: str | None,
    environ: Mapping[str, str],
) -> NasCredential | None:
    """按 credential_ref 读取环境变量；租户或 endpoint 不一致、格式错误一律视为未配置。"""
    if not credential_ref or not endpoint or not NAS_CREDENTIAL_REF_PATTERN.fullmatch(credential_ref):
        return None
    try:
        value = json.loads(environ.get(credential_ref) or "")
        bound_endpoint = normalize_nas_endpoint(str(value["endpoint"]))
    except (ValueError, TypeError, KeyError, ValidationProblem):
        return None
    token = value.get("token")
    if str(value.get("tenant_id")) != str(tenant_id) or bound_endpoint != endpoint:
        return None
    if not isinstance(token, str) or not token.strip():
        return None
    return NasCredential(endpoint=endpoint, token=token)


class NasKnowledgeAdapter(Protocol):
    """NAS 协议只读适配器。返回上游解包后的 JSON；失败抛 NasUnavailable / NasResourceNotFound。"""

    def list_knowledge_bases(self, credential: NasCredential) -> Any: ...

    def search(self, credential: NasCredential, *, knowledge_base_id: str, query: str) -> Any: ...

    def preview_document(self, credential: NasCredential, *, document_id: str) -> Any: ...


class HttpNasKnowledgeAdapter:
    """knowledge-base-provider.md 协议的 HTTP 实现：不跟随重定向、10s 超时、响应上限 4MB。"""

    def __init__(self, *, client: httpx.Client | None = None):
        self._client = client

    def list_knowledge_bases(self, credential: NasCredential) -> Any:
        return self._get(credential, "/api/knowledge-bases", None)

    def search(self, credential: NasCredential, *, knowledge_base_id: str, query: str) -> Any:
        path = f"/api/knowledge-bases/{quote(knowledge_base_id, safe='')}/search"
        return self._get(credential, path, {"q": query})

    def preview_document(self, credential: NasCredential, *, document_id: str) -> Any:
        return self._get(credential, f"/api/knowledge-documents/{quote(document_id, safe='')}/preview", None)

    def _get(self, credential: NasCredential, path: str, params: dict[str, str] | None) -> Any:
        client = self._client or httpx.Client(timeout=_TIMEOUT_SECONDS, follow_redirects=False)
        try:
            with client.stream(
                "GET", credential.endpoint + path, params=params,
                headers={"Authorization": f"Bearer {credential.token}", "Accept": "application/json"},
                follow_redirects=False, timeout=_TIMEOUT_SECONDS,
            ) as response:
                if response.status_code == 404:
                    raise NasResourceNotFound("NAS knowledge resource not found")
                if response.status_code != 200:
                    raise NasUnavailable("NAS knowledge service rejected the request")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise NasUnavailable("NAS knowledge response exceeds the limit")
            payload = json.loads(body)
        except (httpx.HTTPError, ValueError) as exc:
            raise NasUnavailable("NAS knowledge service is unavailable") from exc
        finally:
            if self._client is None:
                client.close()
        return payload["data"] if isinstance(payload, dict) and "data" in payload else payload


class _SpaceReader(Protocol):
    def get(self, ctx: TenantContext, *, knowledge_space_id: str) -> Any: ...


class _DeploymentStore(Protocol):
    def get(self, ctx: TenantContext, *, knowledge_space_id: str) -> KnowledgeSpaceDeploymentRow | None: ...

    def upsert(
        self, ctx: TenantContext, *, knowledge_space_id: str, kind: str,
        endpoint: str | None, credential_ref: str | None,
    ) -> KnowledgeSpaceDeploymentRow: ...


class KnowledgeDeploymentService:
    """部署位置管理（owner/enterprise_admin）。tenant_id 只取自 ctx（D22）。"""

    def __init__(self, *, spaces: _SpaceReader, deployments: _DeploymentStore,
                 environ: Mapping[str, str] | None = None):
        self._spaces = spaces
        self._deployments = deployments
        self._environ = os.environ if environ is None else environ

    def get(self, ctx: TenantContext, *, knowledge_space_id: str) -> KnowledgeSpaceDeploymentOut:
        _ensure_deployment_admin(ctx)
        _require_space(self._spaces, ctx, knowledge_space_id)
        row = self._deployments.get(ctx, knowledge_space_id=knowledge_space_id)
        return self._to_out(ctx, row or KnowledgeSpaceDeploymentRow(knowledge_space_id, "managed"))

    def update(
        self, ctx: TenantContext, *, knowledge_space_id: str, body: KnowledgeSpaceDeploymentUpdate,
    ) -> KnowledgeSpaceDeploymentOut:
        _ensure_deployment_admin(ctx)
        _require_space(self._spaces, ctx, knowledge_space_id)
        if body.kind == "managed":
            if body.endpoint is not None or body.credential_ref is not None:
                raise ValidationProblem("managed deployment must not carry endpoint or credential_ref")
            endpoint = credential_ref = None
        else:
            if not body.endpoint or not body.credential_ref:
                raise ValidationProblem("nas deployment requires endpoint and credential_ref")
            if not NAS_CREDENTIAL_REF_PATTERN.fullmatch(body.credential_ref):
                raise ValidationProblem("credential_ref must match MANAGER_NAS_[A-Z0-9_]{1,64}")
            endpoint, credential_ref = normalize_nas_endpoint(body.endpoint), body.credential_ref
        row = self._deployments.upsert(
            ctx, knowledge_space_id=knowledge_space_id, kind=body.kind,
            endpoint=endpoint, credential_ref=credential_ref,
        )
        return self._to_out(ctx, row)

    def _to_out(self, ctx: TenantContext, row: KnowledgeSpaceDeploymentRow) -> KnowledgeSpaceDeploymentOut:
        resolvable = row.kind == "nas" and resolve_nas_credential(
            row.credential_ref, tenant_id=ctx.tenant_id, endpoint=row.endpoint, environ=self._environ,
        ) is not None
        return KnowledgeSpaceDeploymentOut(
            knowledge_space_id=row.knowledge_space_id, kind=row.kind, endpoint=row.endpoint,
            credential_ref=row.credential_ref, credential_resolvable=resolvable, updated_at=row.updated_at,
        )


class NasKnowledgeGateway:
    """kind=nas 企业知识库的只读网关。本租户已认证成员可读，与托管模式的成员读策略一致。"""

    def __init__(self, *, spaces: _SpaceReader, deployments: _DeploymentStore, adapter: NasKnowledgeAdapter,
                 environ: Mapping[str, str] | None = None):
        self._spaces = spaces
        self._deployments = deployments
        self._adapter = adapter
        self._environ = os.environ if environ is None else environ

    def list_knowledge_bases(self, ctx: TenantContext, *, knowledge_space_id: str) -> list[NasKnowledgeBaseOut]:
        payload = self._adapter.list_knowledge_bases(self._credential(ctx, knowledge_space_id))
        items = payload if isinstance(payload, list) else []
        return [base for base in (_project_base(item) for item in items) if base is not None]

    def search(
        self, ctx: TenantContext, *, knowledge_space_id: str, knowledge_base_id: str, query: str,
    ) -> NasKnowledgeSearchOut:
        payload = self._adapter.search(
            self._credential(ctx, knowledge_space_id), knowledge_base_id=knowledge_base_id, query=query,
        )
        return _project_search(payload, query)

    def preview_document(
        self, ctx: TenantContext, *, knowledge_space_id: str, document_id: str,
    ) -> NasKnowledgeDocumentPreviewOut:
        payload = self._adapter.preview_document(self._credential(ctx, knowledge_space_id), document_id=document_id)
        return _project_preview(payload)

    def _credential(self, ctx: TenantContext, knowledge_space_id: str) -> NasCredential:
        _require_space(self._spaces, ctx, knowledge_space_id)
        row = self._deployments.get(ctx, knowledge_space_id=knowledge_space_id)
        if row is None or row.kind != "nas":
            raise KnowledgeSpaceNotNas("knowledge space is managed by Manager; use the managed knowledge routes")
        credential = resolve_nas_credential(
            row.credential_ref, tenant_id=ctx.tenant_id, endpoint=row.endpoint, environ=self._environ,
        )
        if credential is None:
            raise NasCredentialUnavailable("NAS credential is not configured on this Manager")
        return credential


def deployment_kind(deployments: _DeploymentStore, ctx: TenantContext, knowledge_space_id: str) -> str:
    row = deployments.get(ctx, knowledge_space_id=knowledge_space_id)
    return "managed" if row is None else row.kind


def _ensure_deployment_admin(ctx: TenantContext) -> None:
    if not set(ctx.roles) & _DEPLOYMENT_ADMIN_ROLES:
        raise Forbidden("knowledge deployment requires owner or enterprise_admin")


def _require_space(spaces: _SpaceReader, ctx: TenantContext, knowledge_space_id: str) -> None:
    if spaces.get(ctx, knowledge_space_id=knowledge_space_id) is None:
        raise NotFound("knowledge space not found in this tenant")


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _identifier(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value).strip()
    return text or None


def _project_file(item: Any) -> NasKnowledgeFileOut | None:
    if not isinstance(item, dict):
        return None
    file_id, name = _identifier(item.get("id")), _text(item.get("name"))
    if file_id is None or not name:
        return None
    size = item.get("size")
    return NasKnowledgeFileOut(
        id=file_id, name=name, type=_text(item.get("type")),
        size=size if isinstance(size, (int, str)) and not isinstance(size, bool) else None,
        status=_text(item.get("status")), uploaded_at=_text(item.get("uploaded_at") or item.get("uploadedAt")),
    )


def _project_base(item: Any) -> NasKnowledgeBaseOut | None:
    if not isinstance(item, dict):
        return None
    base_id, name = _identifier(item.get("id")), _text(item.get("name"))
    if base_id is None or not name:
        return None
    doc_count = item.get("doc_count", item.get("docCount"))
    files = item.get("files") if isinstance(item.get("files"), list) else []
    return NasKnowledgeBaseOut(
        id=base_id, name=name, description=_text(item.get("description")),
        directory=_text(item.get("directory")),
        doc_count=doc_count if isinstance(doc_count, int) and not isinstance(doc_count, bool) else None,
        updated_at=_text(item.get("updated_at") or item.get("updatedAt")),
        files=[file for file in (_project_file(entry) for entry in files) if file is not None],
    )


def _project_hits(value: Any) -> list[NasKnowledgeSearchHit]:
    items = value if isinstance(value, list) else []
    return [
        NasKnowledgeSearchHit(
            title=_text(item.get("title")), document_id=_identifier(item.get("document_id")),
            snippet=_text(item.get("snippet")),
        )
        for item in items if isinstance(item, dict)
    ]


def _project_search(payload: Any, query: str) -> NasKnowledgeSearchOut:
    body = payload if isinstance(payload, dict) else {}
    return NasKnowledgeSearchOut(
        query=query, answer=_text(body.get("answer")) or "",
        citations=_project_hits(body.get("citations")), items=_project_hits(body.get("items")),
    )


def _project_preview(payload: Any) -> NasKnowledgeDocumentPreviewOut:
    body = payload if isinstance(payload, dict) else {}
    content_type = _text(body.get("content_type") or body.get("contentType"))
    file_type = _text(body.get("file_type") or body.get("fileType"))
    mode, content = body.get("mode"), _text(body.get("content"))
    if mode not in ("text", "markdown") or content is None:
        return NasKnowledgeDocumentPreviewOut(mode="unsupported", content_type=content_type, file_type=file_type)
    return NasKnowledgeDocumentPreviewOut(
        mode=mode, content_type=content_type, file_type=file_type, content=content,
        truncated=body.get("truncated") is True,
    )


__all__ = [
    "HttpNasKnowledgeAdapter",
    "KnowledgeDeploymentService",
    "KnowledgeSpaceNotNas",
    "NasCredential",
    "NasCredentialUnavailable",
    "NasKnowledgeAdapter",
    "NasKnowledgeGateway",
    "NasResourceNotFound",
    "NasUnavailable",
    "deployment_kind",
    "normalize_nas_endpoint",
    "resolve_nas_credential",
]
