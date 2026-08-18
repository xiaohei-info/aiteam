from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import manager_service.knowledge_artifact_service as artifact_service
from manager_service.knowledge_artifact_service import KnowledgeArtifactBundleService
from manager_service.knowledge_intake_repository import KnowledgeDocumentBindingRow, KnowledgeDocumentRow
from manager_service.knowledge_intake_service import _resolve_path, _store_bytes, ensure_storage_root
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext


class _Config:
    def __init__(self):
        self.requests = []

    def pull(self, ctx, req):
        self.requests.append(req)
        return type("Config", (), {"experts": [{"employee_id": "employee-a"}]})()


class _Snapshot:
    def generate(self, ctx, *, member_id, employee_id, employee_version=None):
        return EmployeeExecutionSnapshot(
            employee_id=employee_id, version="1", snapshot_version="snap-1",
            knowledge_refs=["space-a"],
        )


class _Documents:
    def __init__(self, row):
        self.row = row

    def get(self, ctx, *, document_id):
        return self.row if document_id == self.row.id else None


class _Bindings:
    def __init__(self, *, tenant_id="tenant-a", knowledge_space_id="space-a"):
        self.tenant_id = tenant_id
        self.knowledge_space_id = knowledge_space_id

    def list_by_employee(self, ctx, *, employee_id, status=None):
        return [KnowledgeDocumentBindingRow(
            id="binding-a", tenant_id=self.tenant_id, knowledge_space_id=self.knowledge_space_id,
            document_id="doc-a", employee_id=employee_id, rag_document_id=None,
            status="ready", last_synced_at=None, created_at=None,
        )]


def test_bundle_is_authorized_and_contains_stable_citation(tmp_path: Path):
    stored = tmp_path / "knowledge" / "tenant-a" / "space-a" / "doc.txt"
    stored.parent.mkdir(parents=True)
    stored.write_text("offline handbook policy", encoding="utf-8")
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="doc.txt", file_type="text/plain", file_size=23,
        storage_key="knowledge/tenant-a/space-a/doc.txt", status="ready",
    )
    config = _Config()
    service = KnowledgeArtifactBundleService(
        config=config, snapshot=_Snapshot(), documents=_Documents(doc), bindings=_Bindings(), storage_root=tmp_path,
    )
    ctx = TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",))
    first = service.pull(ctx, known_versions={})
    second = service.pull(ctx, known_versions={"cite": "old"})
    assert first == second
    assert first["authoritative"] is True
    assert first["artifacts"][0]["employee_id"] == "employee-a"
    assert first["artifacts"][0]["content"] == "offline handbook policy"
    assert first["artifacts"][0]["artifact_version"].startswith("exporter:knowledge-export-v1;chunker:fixed-chunker-1200-v1;")
    assert first["artifacts"][0]["citation_id"]
    assert [request.known_versions for request in config.requests] == [{}, {}]


def test_bundle_service_constructs_with_real_employee_binding_repository(monkeypatch, tmp_path: Path):
    import manager_service.routes_knowledge_artifacts as routes
    from fastapi import FastAPI

    app = FastAPI()
    app.state.settings = SimpleNamespace(db_url="postgresql://unused", manager_data_root=tmp_path)
    monkeypatch.setattr(routes, "_authorized_config_service", lambda _request: _Config())
    request = SimpleNamespace(app=app)
    service = routes._bundle_service(request)
    assert service is app.state._knowledge_artifact_bundle_service
    assert service._bindings.__class__.__name__ == "KnowledgeDocumentBindingRepository"
    assert service._snapshot._knowledge_binding.__class__.__name__ == "EmployeeKnowledgeBindingRepository"


def test_bundle_route_accepts_only_known_versions_and_no_query_or_workspace():
    from manager_service.routes_knowledge_artifacts import build_knowledge_artifact_router
    from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
    from fastapi import FastAPI

    verifier, signer = make_inmem_verifier_and_signer()
    app = FastAPI()
    app.include_router(build_knowledge_artifact_router(verifier))
    bundle = Mock()
    bundle.pull.return_value = {"artifacts": [], "authoritative": True}
    app.state._knowledge_artifact_bundle_service = bundle
    token = sign_inmem_token(signer, "tenant-a", ["member"], user_id="member-a")
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/manager/knowledge/artifacts/bundle", json={"query": "secret"}, headers=headers).status_code == 422
    response = client.post("/api/manager/knowledge/artifacts/bundle", json={"known_versions": {"doc-a": "v1"}}, headers=headers)
    assert response.status_code == 200
    bundle.pull.assert_called_once()


def test_bundle_rejects_binding_document_space_mismatch(tmp_path: Path):
    stored = tmp_path / "knowledge" / "tenant-a" / "space-a" / "doc.txt"
    stored.parent.mkdir(parents=True)
    stored.write_text("content", encoding="utf-8")
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="doc.txt", file_type="text/plain", file_size=7,
        storage_key="knowledge/tenant-a/space-a/doc.txt", status="ready",
    )
    service = KnowledgeArtifactBundleService(
        config=_Config(), snapshot=_Snapshot(), documents=_Documents(doc),
        bindings=_Bindings(knowledge_space_id="space-other"), storage_root=tmp_path,
    )
    with pytest.raises(ValueError, match="space mismatch"):
        service.pull(TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",)))


def test_bundle_rejects_binding_document_tenant_mismatch(tmp_path: Path):
    stored = tmp_path / "knowledge" / "tenant-a" / "space-a" / "doc.txt"
    stored.parent.mkdir(parents=True)
    stored.write_text("content", encoding="utf-8")
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="doc.txt", file_type="text/plain", file_size=7,
        storage_key="knowledge/tenant-a/space-a/doc.txt", status="ready",
    )
    service = KnowledgeArtifactBundleService(
        config=_Config(), snapshot=_Snapshot(), documents=_Documents(doc),
        bindings=_Bindings(tenant_id="tenant-other"), storage_root=tmp_path,
    )
    with pytest.raises(ValueError, match="tenant mismatch"):
        service.pull(TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",)))


def test_bundle_rejects_missing_file(tmp_path: Path):
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="doc.txt", file_type="text/plain", file_size=7,
        storage_key="knowledge/tenant-a/space-a/missing.txt", status="ready",
    )
    service = KnowledgeArtifactBundleService(
        config=_Config(), snapshot=_Snapshot(), documents=_Documents(doc), bindings=_Bindings(), storage_root=tmp_path,
    )
    with pytest.raises(ValueError, match="file is missing"):
        service.pull(TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",)))


def test_storage_key_prefix_collision_is_rejected(tmp_path: Path):
    with pytest.raises(ValueError):
        _resolve_path(tmp_path, "../" + tmp_path.name + "-evil/file.txt")


def test_new_storage_uses_private_namespace_permissions(tmp_path: Path):
    key = _store_bytes(tmp_path, "space-a", "doc.txt", b"content", tenant_id="tenant-a")
    assert key.startswith("knowledge/tenant-a/space-a/")
    assert (tmp_path / key).stat().st_mode & 0o777 == 0o600
    assert (tmp_path / "knowledge" / "tenant-a" / "space-a").stat().st_mode & 0o777 == 0o700


@pytest.mark.parametrize("symlink_component", ["tenant", "space"])
def test_storage_rejects_symlinked_namespace_components(tmp_path: Path, symlink_component: str):
    knowledge = tmp_path / "knowledge"
    knowledge.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    tenant = knowledge / "tenant-a"
    tenant.mkdir()
    if symlink_component == "tenant":
        tenant.rmdir()
        tenant.symlink_to(outside, target_is_directory=True)
    else:
        (tenant / "space-a").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlinked knowledge namespace"):
        _store_bytes(tmp_path, "space-a", "doc.txt", b"content", tenant_id="tenant-a")


def test_bundle_enforces_aggregate_count_bytes_and_response_limits(tmp_path: Path, monkeypatch):
    stored = tmp_path / "knowledge" / "tenant-a" / "space-a" / "doc.txt"
    stored.parent.mkdir(parents=True)
    stored.write_text("content", encoding="utf-8")
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="doc.txt", file_type="text/plain", file_size=7,
        storage_key="knowledge/tenant-a/space-a/doc.txt", status="ready",
    )
    service = KnowledgeArtifactBundleService(
        config=_Config(), snapshot=_Snapshot(), documents=_Documents(doc), bindings=_Bindings(), storage_root=tmp_path,
    )
    ctx = TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",))
    monkeypatch.setattr(artifact_service, "MAX_BUNDLE_ARTIFACTS", 0)
    with pytest.raises(ValueError, match="artifact count limit"):
        service.pull(ctx)
    monkeypatch.setattr(artifact_service, "MAX_BUNDLE_ARTIFACTS", 4_096)
    monkeypatch.setattr(artifact_service, "MAX_BUNDLE_ARTIFACT_BYTES", 2)
    with pytest.raises(ValueError, match="artifact byte limit"):
        service.pull(ctx)
    monkeypatch.setattr(artifact_service, "MAX_BUNDLE_ARTIFACT_BYTES", 32 * 1024 * 1024)
    monkeypatch.setattr(artifact_service, "MAX_BUNDLE_RESPONSE_BYTES", 1)
    with pytest.raises(ValueError, match="response limit"):
        service.pull(ctx)


def test_storage_namespace_and_permissions_are_repaired(tmp_path: Path):
    legacy = tmp_path / "knowledge" / "space-a" / "legacy.txt"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("legacy", encoding="utf-8")
    legacy.chmod(0o644)
    (tmp_path / "knowledge").chmod(0o755)
    ensure_storage_root(tmp_path)
    assert (tmp_path / "knowledge").stat().st_mode & 0o777 == 0o700
    assert legacy.stat().st_mode & 0o777 == 0o600
    doc = KnowledgeDocumentRow(
        id="doc-a", tenant_id="tenant-a", knowledge_space_id="space-a", display_name="Handbook",
        source_type="file", file_name="legacy.txt", file_type="text/plain", file_size=6,
        storage_key="knowledge/space-a/legacy.txt", status="ready",
    )
    service = KnowledgeArtifactBundleService(
        config=_Config(), snapshot=_Snapshot(), documents=_Documents(doc), bindings=_Bindings(), storage_root=tmp_path,
    )
    with pytest.raises(ValueError, match="namespace"):
        service.pull(TenantContext(tenant_id="tenant-a", user_id="member-a", roles=("member",)))
