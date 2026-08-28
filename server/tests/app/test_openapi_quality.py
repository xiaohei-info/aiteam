"""OpenAPI quality gate for the two FastAPI control planes.

The full three-tier gate also runs scripts/check-openapi.sh in CI; this test
keeps the control-plane contract close to the regular Python test suite.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from run import get_app


@pytest.mark.parametrize("tier", ("operation", "manager"))
def test_control_plane_openapi_is_documented(tier: str) -> None:
    spec = TestClient(get_app(tier)).get("/openapi.json").json()
    assert "bearerAuth" in spec["components"]["securitySchemes"]
    assert "serviceToken" in spec["components"]["securitySchemes"]
    assert spec["components"]["responses"]["ValidationError"]["content"]["application/problem+json"]
    operation_ids: set[str] = set()

    for path, path_item in spec["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, operation in path_item.items():
            if method not in {"get", "post", "put", "patch", "delete"}:
                continue
            label = f"{method.upper()} {path}"
            assert operation.get("summary"), f"{label} missing summary"
            assert operation.get("description"), f"{label} missing description"
            assert operation["description"] != "请查看接口名称了解用途"
            assert operation.get("tags"), f"{label} missing tags"
            operation_id = operation.get("operationId")
            assert operation_id and operation_id not in operation_ids, f"{label} duplicate operationId"
            operation_ids.add(operation_id)
            assert operation["responses"].get("422", {}).get("$ref") == "#/components/responses/ValidationError", f"{label} missing unified validation response"
            if path.endswith("/ping") or path.startswith("/api/auth/") or path == "/api/operation/auth/login":
                assert operation["security"] == []
            elif operation_id in {
                "operation_ingest_rollup",
                "operation_platform_provider_pull",
                "operation_tenant_provider_access_resolve",
                "manager_provision_tenant",
                "manager_owner_bootstrap",
                "manager_catalog_notify",
                "manager_inbox_deliver_from_operation",
            } or path.startswith("/api/operation/catalog/pull/") or path.startswith("/api/operation/skill-market/pull/"):
                assert operation["security"] == [{"serviceToken": []}]
            else:
                assert operation["security"] == [{"bearerAuth": []}]

    if tier == "manager":
        assert "/api/manager/llm/providers" in spec["paths"]
        assert "/api/manager/llm/models" in spec["paths"]
