"""企业知识库部署位置 + NAS 只读网关验收（议题 6；非 integration，不依赖 PG）。

验：
- 部署位置仅 owner/enterprise_admin 可读写；member 403；managed 不得带 endpoint/credential_ref。
- credential_ref 只解析 MANAGER_NAS_ 前缀环境变量，tenant_id/endpoint 不一致视为未配置；凭据值不出参。
- 网关：非 NAS → 409；凭据未配置 → 503；member 可读；上游字段（level、内网 URL）不透传。
- HttpNasKnowledgeAdapter：Bearer、路径编码、不跟随重定向、404/非 200/超限映射。
- KnowledgeSpaceOut 仅带 deployment_kind。
"""

from __future__ import annotations

import json

import httpx
import pytest

from manager_service.knowledge_nas_gateway import (
    HttpNasKnowledgeAdapter,
    KnowledgeDeploymentService,
    KnowledgeSpaceNotNas,
    NasCredential,
    NasCredentialUnavailable,
    NasKnowledgeGateway,
    NasResourceNotFound,
    NasUnavailable,
    normalize_nas_endpoint,
    resolve_nas_credential,
)
from manager_service.knowledge_space_repository import (
    KnowledgeSpaceDeploymentRow,
    KnowledgeSpaceRow,
)
from manager_service.knowledge_space_service import KnowledgeSpaceService
from manager_service.schemas import KnowledgeSpaceDeploymentUpdate, KnowledgeSpaceOut
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound, ValidationProblem

TENANT_A = "00000000-0000-4000-8000-00000000000a"
TENANT_B = "00000000-0000-4000-8000-00000000000b"
ENDPOINT = "https://nas.example.invalid"
REF = "MANAGER_NAS_FINANCE"


def _ctx(tenant_id: str = TENANT_A, roles=("owner",)) -> TenantContext:
    return TenantContext(tenant_id=tenant_id, user_id="u-1", roles=list(roles))


def _env(tenant_id: str = TENANT_A, endpoint: str = ENDPOINT, token: str = "nas-secret") -> dict[str, str]:
    return {REF: json.dumps({"tenant_id": tenant_id, "endpoint": endpoint, "token": token})}


class _Spaces:
    def __init__(self, *ids: str):
        self._ids = set(ids)

    def get(self, ctx, *, knowledge_space_id):
        if knowledge_space_id not in self._ids:
            return None
        return KnowledgeSpaceRow(knowledge_space_id=knowledge_space_id, workspace="w", display_name="企业知识库",
                                 created_at=None)


class _Deployments:
    """按 tenant 分桶（模拟 RLS）。"""

    def __init__(self):
        self._store: dict[tuple[str, str], KnowledgeSpaceDeploymentRow] = {}

    def get(self, ctx, *, knowledge_space_id):
        return self._store.get((ctx.tenant_id, knowledge_space_id))

    def upsert(self, ctx, *, knowledge_space_id, kind, endpoint, credential_ref):
        row = KnowledgeSpaceDeploymentRow(knowledge_space_id, kind, endpoint, credential_ref)
        self._store[(ctx.tenant_id, knowledge_space_id)] = row
        return row


class _FakeAdapter:
    def __init__(self):
        self.calls: list[tuple] = []

    def list_knowledge_bases(self, credential):
        self.calls.append(("list", credential))
        return [
            {"id": "kb-1", "name": "财务制度", "level": "enterprise", "docCount": 2, "directory": "制度",
             "files": [{"id": 7, "name": "报销.md", "size": 1024, "uploadedAt": "2026-10-01", "previewUrl": "http://10.0.0.5/x"},
                       {"name": "无 id"}]},
            {"id": "", "name": "坏数据"},
            "not-a-dict",
        ]

    def search(self, credential, *, knowledge_base_id, query):
        self.calls.append(("search", knowledge_base_id, query))
        return {"answer": "按制度报销", "citations": [{"title": "报销.md", "document_id": "7"}],
                "items": [{"title": "报销.md", "document_id": 7, "snippet": "差旅", "score": 0.9}]}

    def preview_document(self, credential, *, document_id):
        self.calls.append(("preview", document_id))
        if document_id == "img":
            return {"mode": "image", "contentType": "image/png", "objectUrl": "http://10.0.0.5/img"}
        return {"mode": "markdown", "contentType": "text/markdown", "fileType": "md", "content": "# 报销", "truncated": True}


def _nas_setup(environ=None):
    spaces, deployments, adapter = _Spaces("enterprise_shared"), _Deployments(), _FakeAdapter()
    env = _env() if environ is None else environ
    admin = KnowledgeDeploymentService(spaces=spaces, deployments=deployments, environ=env)
    gateway = NasKnowledgeGateway(spaces=spaces, deployments=deployments, adapter=adapter, environ=env)
    return admin, gateway, adapter, deployments


def _set_nas(admin, ctx=None):
    return admin.update(ctx or _ctx(), knowledge_space_id="enterprise_shared",
                        body=KnowledgeSpaceDeploymentUpdate(kind="nas", endpoint=ENDPOINT + "/", credential_ref=REF))


# ---- endpoint / credential_ref ----


@pytest.mark.parametrize("raw", ["http://nas.example.invalid", "ftp://x", "https://u:p@nas.example.invalid",
                                 "https://nas.example.invalid?x=1", "https://nas.example.invalid#f", "nas"])
def test_normalize_nas_endpoint_rejects_unsafe_urls(raw):
    with pytest.raises(ValidationProblem):
        normalize_nas_endpoint(raw)


def test_normalize_nas_endpoint_allows_https_and_loopback_http():
    assert normalize_nas_endpoint(" https://nas.example.invalid/kb/ ") == "https://nas.example.invalid/kb"
    assert normalize_nas_endpoint("http://127.0.0.1:8783") == "http://127.0.0.1:8783"
    assert normalize_nas_endpoint("http://localhost:8783/") == "http://localhost:8783"


def test_resolve_nas_credential_requires_matching_tenant_and_endpoint():
    assert resolve_nas_credential(REF, tenant_id=TENANT_A, endpoint=ENDPOINT, environ=_env()) == NasCredential(
        ENDPOINT, "nas-secret")
    assert resolve_nas_credential(REF, tenant_id=TENANT_B, endpoint=ENDPOINT, environ=_env()) is None
    assert resolve_nas_credential(REF, tenant_id=TENANT_A, endpoint="https://evil.example.invalid",
                                  environ=_env()) is None
    assert resolve_nas_credential("PATH", tenant_id=TENANT_A, endpoint=ENDPOINT, environ={"PATH": "x"}) is None
    assert resolve_nas_credential(REF, tenant_id=TENANT_A, endpoint=ENDPOINT, environ={REF: "not-json"}) is None
    assert resolve_nas_credential(REF, tenant_id=TENANT_A, endpoint=ENDPOINT,
                                  environ=_env(token=" ")) is None
    assert "nas-secret" not in repr(NasCredential(ENDPOINT, "nas-secret"))


# ---- 部署位置管理 ----


def test_deployment_defaults_to_managed_and_member_cannot_read_or_write():
    admin, *_ = _nas_setup()
    out = admin.get(_ctx(), knowledge_space_id="enterprise_shared")
    assert (out.kind, out.endpoint, out.credential_ref, out.credential_resolvable) == ("managed", None, None, False)
    member = _ctx(roles=("member",))
    with pytest.raises(Forbidden):
        admin.get(member, knowledge_space_id="enterprise_shared")
    with pytest.raises(Forbidden):
        _set_nas(admin, member)


def test_deployment_nas_roundtrip_reports_resolvable_without_secret():
    admin, *_ = _nas_setup()
    out = _set_nas(admin, _ctx(roles=("enterprise_admin",)))
    assert (out.kind, out.endpoint, out.credential_ref, out.credential_resolvable) == ("nas", ENDPOINT, REF, True)
    assert "nas-secret" not in out.model_dump_json()
    # 换租户视角：同一环境变量绑定 tenant A，B 不可解析。
    admin_b, *_ = _nas_setup()
    admin_b._spaces = _Spaces("enterprise_shared")
    assert _set_nas(admin_b, _ctx(TENANT_B)).credential_resolvable is False


def test_deployment_validation_and_missing_space():
    admin, *_ = _nas_setup()
    with pytest.raises(ValidationProblem):
        admin.update(_ctx(), knowledge_space_id="enterprise_shared",
                     body=KnowledgeSpaceDeploymentUpdate(kind="managed", endpoint=ENDPOINT))
    with pytest.raises(ValidationProblem):
        admin.update(_ctx(), knowledge_space_id="enterprise_shared",
                     body=KnowledgeSpaceDeploymentUpdate(kind="nas", endpoint=ENDPOINT))
    with pytest.raises(ValidationProblem):
        admin.update(_ctx(), knowledge_space_id="enterprise_shared",
                     body=KnowledgeSpaceDeploymentUpdate(kind="nas", endpoint=ENDPOINT, credential_ref="DB_URL"))
    with pytest.raises(NotFound):
        admin.get(_ctx(), knowledge_space_id="missing")
    back = admin.update(_ctx(), knowledge_space_id="enterprise_shared",
                        body=KnowledgeSpaceDeploymentUpdate(kind="managed"))
    assert (back.kind, back.endpoint, back.credential_ref) == ("managed", None, None)


# ---- 只读网关 ----


def test_gateway_rejects_managed_space_and_unresolved_credential():
    admin, gateway, adapter, _ = _nas_setup()
    with pytest.raises(KnowledgeSpaceNotNas):
        gateway.list_knowledge_bases(_ctx(roles=("member",)), knowledge_space_id="enterprise_shared")
    with pytest.raises(NotFound):
        gateway.list_knowledge_bases(_ctx(), knowledge_space_id="missing")
    _set_nas(admin)
    _, unresolved, _, _ = _nas_setup(environ={})
    unresolved._deployments = gateway._deployments
    with pytest.raises(NasCredentialUnavailable):
        unresolved.list_knowledge_bases(_ctx(), knowledge_space_id="enterprise_shared")
    assert adapter.calls == []


def test_gateway_member_reads_projected_nas_content():
    admin, gateway, adapter, _ = _nas_setup()
    _set_nas(admin)
    member = _ctx(roles=("member",))

    bases = gateway.list_knowledge_bases(member, knowledge_space_id="enterprise_shared")
    assert [base.id for base in bases] == ["kb-1"]
    dumped = bases[0].model_dump()
    assert dumped["doc_count"] == 2 and "level" not in dumped
    assert [(f.id, f.uploaded_at) for f in bases[0].files] == [("7", "2026-10-01")]
    assert "10.0.0.5" not in bases[0].model_dump_json()
    assert adapter.calls[0] == ("list", NasCredential(ENDPOINT, "nas-secret"))

    found = gateway.search(member, knowledge_space_id="enterprise_shared", knowledge_base_id="kb-1", query="报销")
    assert found.answer == "按制度报销" and found.items[0].document_id == "7"
    assert "score" not in found.items[0].model_dump()

    preview = gateway.preview_document(member, knowledge_space_id="enterprise_shared", document_id="7")
    assert (preview.mode, preview.content, preview.content_type, preview.truncated) == (
        "markdown", "# 报销", "text/markdown", True)
    image = gateway.preview_document(member, knowledge_space_id="enterprise_shared", document_id="img")
    assert image.mode == "unsupported" and image.content is None
    assert "10.0.0.5" not in image.model_dump_json()


def test_gateway_is_tenant_scoped():
    admin, gateway, _, _ = _nas_setup()
    _set_nas(admin)
    with pytest.raises(KnowledgeSpaceNotNas):
        gateway.list_knowledge_bases(_ctx(TENANT_B, ("member",)), knowledge_space_id="enterprise_shared")


# ---- HTTP adapter ----


def _adapter(handler) -> HttpNasKnowledgeAdapter:
    return HttpNasKnowledgeAdapter(client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_http_adapter_sends_bearer_and_unwraps_envelope():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [{"id": "kb-1", "name": "财务"}]})

    adapter = _adapter(handler)
    credential = NasCredential(ENDPOINT, "nas-secret")
    assert adapter.list_knowledge_bases(credential) == [{"id": "kb-1", "name": "财务"}]
    adapter.search(credential, knowledge_base_id="a/b", query="报销 制度")
    adapter.preview_document(credential, document_id="../x")
    assert seen[0].headers["Authorization"] == "Bearer nas-secret"
    assert seen[1].url.raw_path.decode() == "/api/knowledge-bases/a%2Fb/search?q=%E6%8A%A5%E9%94%80+%E5%88%B6%E5%BA%A6"
    assert seen[2].url.raw_path.decode() == "/api/knowledge-documents/..%2Fx/preview"


@pytest.mark.parametrize(("response", "error"), [
    (httpx.Response(404, json={}), NasResourceNotFound),
    (httpx.Response(401, json={}), NasUnavailable),
    (httpx.Response(302, headers={"Location": "https://evil.example.invalid"}), NasUnavailable),
    (httpx.Response(200, content=b"not json"), NasUnavailable),
    (httpx.Response(200, content=b"x" * (4 * 1024 * 1024 + 1)), NasUnavailable),
])
def test_http_adapter_maps_upstream_failures(response, error):
    with pytest.raises(error):
        _adapter(lambda _request: response).list_knowledge_bases(NasCredential(ENDPOINT, "nas-secret"))


def test_http_adapter_maps_transport_errors():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(NasUnavailable) as caught:
        _adapter(handler).list_knowledge_bases(NasCredential(ENDPOINT, "nas-secret"))
    assert "nas-secret" not in str(caught.value.detail)


# ---- KnowledgeSpaceOut 只带 deployment_kind ----


class _SpaceRepoForService(_Spaces):
    def list_all(self, ctx):
        return [self.get(ctx, knowledge_space_id=i) for i in sorted(self._ids)]


def test_knowledge_space_out_exposes_only_deployment_kind():
    deployments = _Deployments()
    svc = KnowledgeSpaceService(repo=_SpaceRepoForService("enterprise_shared"), binding_repo=None,
                                expert_binding=None, deployment_repo=deployments)
    member = _ctx(roles=("member",))
    assert svc.get(member, knowledge_space_id="enterprise_shared").deployment_kind == "managed"
    deployments.upsert(_ctx(), knowledge_space_id="enterprise_shared", kind="nas", endpoint=ENDPOINT,
                       credential_ref=REF)
    out = svc.list_all(member)[0]
    assert out.deployment_kind == "nas"
    assert {"endpoint", "credential_ref"}.isdisjoint(KnowledgeSpaceOut.model_fields)
    assert REF not in out.model_dump_json()
