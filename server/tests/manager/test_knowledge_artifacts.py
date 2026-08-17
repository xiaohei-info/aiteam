from __future__ import annotations

from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from manager_service.knowledge_artifact_client import (
    KnowledgeArtifactClient,
    KnowledgeArtifactSettings,
    KnowledgeArtifactUnavailable,
)
from manager_service.knowledge_artifact_service import KnowledgeArtifactService
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden


def _ctx() -> TenantContext:
    return TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["member"])


def _snapshot(*refs: str) -> EmployeeExecutionSnapshot:
    return EmployeeExecutionSnapshot(
        employee_id="employee-a", version="1", snapshot_version="snapshot-a",
        display_name="Expert", knowledge_refs=list(refs),
    )


def test_service_rejects_unbound_reference_before_forwarding():
    snapshot = Mock()
    snapshot.generate.return_value = _snapshot("set-a")
    index = Mock()
    service = KnowledgeArtifactService(snapshot=snapshot, index=index)

    with pytest.raises(Forbidden):
        service.search(
            _ctx(), employee_id="employee-a", knowledge_refs=["set-b"], query="q", limit=1
        )
    index.search.assert_not_called()


def test_artifact_client_missing_config_fails_closed():
    client = KnowledgeArtifactClient(KnowledgeArtifactSettings(None, None, None, None))

    with pytest.raises(KnowledgeArtifactUnavailable):
        client.search(_ctx(), employee_id="employee-a", knowledge_refs=["set-a"], query="q", limit=1)


def test_artifact_client_transport_error_is_unavailable():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    client = KnowledgeArtifactClient(
        KnowledgeArtifactSettings("http://index", "secret", "/search", "/get"),
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(KnowledgeArtifactUnavailable):
        client.search(_ctx(), employee_id="employee-a", knowledge_refs=["set-a"], query="q", limit=1)


def test_get_route_preserves_citation_response_shape():
    from manager_service.routes_knowledge_artifacts import build_knowledge_artifact_router
    from shared.app_factory import create_app
    from shared.config import Settings
    from manager_service.app import router as manager_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = verifier
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.include_router(build_knowledge_artifact_router(verifier))
    service = Mock()
    service.get.return_value = {
        "citation": {"citation_id": "citation-a", "text": "authorized text", "source": "doc-a"}
    }
    app.state._knowledge_artifact_service = service
    token = sign_inmem_token(signer, "tenant-a", ["member"], user_id="member-a")

    response = TestClient(app).post(
        "/api/manager/knowledge/artifacts/get",
        json={"employee_id": "employee-a", "knowledge_refs": ["set-a"], "citation_id": "citation-a"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["citation"]["citation_id"] == "citation-a"
    assert response.json()["data"]["citation"]["text"] == "authorized text"
    service.get.assert_called_once()


def test_artifact_route_does_not_accept_tenant_or_member_ids():
    from manager_service.routes_knowledge_artifacts import build_knowledge_artifact_router
    from shared.app_factory import create_app
    from shared.config import Settings
    from manager_service.app import router as manager_router
    from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"), manager_router)
    app.include_router(build_knowledge_artifact_router(verifier))
    token = sign_inmem_token(signer, "tenant-a", ["member"], user_id="member-a")
    response = TestClient(app).post(
        "/api/manager/knowledge/artifacts/search",
        json={"tenant_id": "other", "member_id": "other", "employee_id": "employee-a",
              "knowledge_refs": ["set-a"], "query": "q", "limit": 1},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
