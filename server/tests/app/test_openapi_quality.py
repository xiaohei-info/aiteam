"""OpenAPI quality gate for the two FastAPI control planes.

The full three-tier gate also runs scripts/check-openapi.sh in CI; this test
keeps the control-plane contract close to the regular Python test suite.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from run import get_app

HTTP_METHODS = {"get", "post", "put", "patch", "delete"}
CONTROL_PLANE_OPERATION_MINIMUMS = {"operation": 55, "manager": 174}


def _operations(spec: dict[str, Any]):
    for path, path_item in spec["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, operation in path_item.items():
            if method in HTTP_METHODS:
                yield path, method, operation


def _resolve_ref(spec: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    ref = value.get("$ref")
    if not isinstance(ref, str):
        return value
    name = ref.rsplit("/", 1)[-1]
    return spec["components"].get("responses", {}).get(name, value)


def _has_example(value: dict[str, Any]) -> bool:
    return bool(value.get("example") is not None or value.get("examples"))


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
            if operation.get("x-protocol") != "mcp":
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
                assert "403" not in operation["responses"], f"{label} service-token route must not claim role-based 403"
            else:
                assert operation["security"] == [{"bearerAuth": []}]

    if tier == "manager":
        assert "/api/manager/llm/providers" in spec["paths"]
        assert "/api/manager/llm/models" in spec["paths"]


@pytest.mark.parametrize("tier", ("operation", "manager"))
def test_control_plane_openapi_has_complete_examples_and_headers(tier: str) -> None:
    """Every mounted control-plane operation is directly consumable from Swagger."""
    spec = TestClient(get_app(tier)).get("/openapi.json").json()
    operations = list(_operations(spec))
    assert len(operations) >= CONTROL_PLANE_OPERATION_MINIMUMS[tier]
    assert spec["info"]["description"].find("示例中的 token") >= 0

    for path, method, operation in operations:
        label = f"{method.upper()} {path}"
        assert operation["summary"], f"{label} missing summary"
        assert operation["description"], f"{label} missing description"
        assert operation["tags"], f"{label} missing tags"
        for parameter in operation.get("parameters", []):
            assert parameter.get("description"), f"{label} parameter lacks description"
            assert _has_example(parameter), f"{label} parameter {parameter.get('name')} lacks example"
            if parameter.get("in") == "path":
                assert parameter.get("required") is True, f"{label} path parameter must be required"

        request_body = operation.get("requestBody")
        if request_body:
            assert request_body.get("description"), f"{label} request body lacks description"
            for media_type, media in request_body.get("content", {}).items():
                assert media.get("schema"), f"{label} request {media_type} lacks schema"
                assert _has_example(media), f"{label} request {media_type} lacks example"

        if operation.get("x-protocol") != "mcp":
            assert "500" in operation["responses"], f"{label} missing internal error response"
        for status, raw_response in operation["responses"].items():
            response = _resolve_ref(spec, raw_response)
            if status.startswith("2"):
                assert "headers" in response and {"X-Request-ID", "X-Trace-ID"} <= set(response["headers"]), (
                    f"{label} success {status} lacks request/trace headers"
                )
                if status == "204":
                    continue
                for media_type, media in response.get("content", {}).items():
                    assert media.get("schema"), f"{label} response {status} {media_type} lacks schema"
                    assert _has_example(media), f"{label} response {status} {media_type} lacks example"
            elif status in {"400", "401", "403", "404", "409", "422", "429", "500", "503"}:
                if operation.get("x-protocol") == "mcp" and status in {"400", "404", "409", "500"}:
                    protocol_content = response.get("content", {}).get("application/json")
                    assert protocol_content and _has_example(protocol_content), f"{label} protocol error {status} lacks JSON-RPC example"
                    assert {"X-Request-ID", "X-Trace-ID"} <= set(response.get("headers", {})), f"{label} protocol error {status} lacks trace headers"
                    continue
                content = response.get("content", {})
                problem = content.get("application/problem+json")
                assert problem and problem.get("schema", {}).get("$ref") == "#/components/schemas/Problem", (
                    f"{label} error {status} must use Problem schema"
                )
                assert _has_example(problem), f"{label} error {status} lacks example"
                assert {"X-Request-ID", "X-Trace-ID"} <= set(response.get("headers", {})), (
                    f"{label} error {status} lacks request/trace headers"
                )


@pytest.mark.parametrize("tier", ("operation", "manager"))
def test_control_plane_openapi_documents_known_bounds(tier: str) -> None:
    spec = TestClient(get_app(tier)).get("/openapi.json").json()
    schemas = spec["components"]["schemas"]
    assert spec["components"]["headers"]["RequestId"]["schema"]["maxLength"] == 128
    assert spec["components"]["headers"]["TraceId"]["schema"]["maxLength"] == 128
    assert spec["components"]["responses"]["ValidationError"]["content"]["application/problem+json"]["examples"]

    if tier == "operation":
        report = spec["paths"]["/api/operation/rollups/report"]["get"]
        params = {item["name"]: item for item in report["parameters"]}
        assert params["period"]["schema"]["enum"] == ["day", "week", "month"]
        assert "token_total" in params["metric"]["schema"]["enum"]
        detail = schemas["EnterpriseAccountDetail"]["properties"]
        assert detail["recharge_records"]["items"]["$ref"] == "#/components/schemas/EnterpriseRechargeRecord"
        assert detail["audit_events"]["items"]["$ref"] == "#/components/schemas/EnterpriseAuditRecord"
        assert detail["token_history"]["items"]["$ref"] == "#/components/schemas/EnterpriseTokenHistory"
        assert schemas["EnterpriseExportResponse"]["properties"]["rows"]["items"]["$ref"] == "#/components/schemas/EnterpriseExportRow"
        assert "404" not in spec["paths"]["/api/operation/rollups/{enterprise_id}"]["get"]["responses"]
        assert "409" not in spec["paths"]["/api/operation/auth/login"]["post"]["responses"]
        access = spec["paths"]["/api/operation/provider-access/resolve"]["post"]["responses"]["200"]
        assert access["headers"]["Cache-Control"]["$ref"] == "#/components/headers/CacheControl"
        finance = schemas["FinanceOverviewOut"]["properties"]
        assert finance["monthly_trend"]["items"]["$ref"] == "#/components/schemas/FinanceTrendPoint"
        assert finance["top5_consumers"]["items"]["$ref"] == "#/components/schemas/FinanceConsumerPoint"
    else:
        upload = spec["paths"]["/api/manager/knowledge-spaces/{knowledge_space_id}/documents"]["post"]
        upload_schema = schemas["Body_manager_knowledge_intake_upload"]
        assert upload_schema["properties"]["file"]["format"] == "binary"
        assert "4 MiB" in upload_schema["properties"]["file"]["description"]
        upload_media = upload["requestBody"]["content"]["multipart/form-data"]
        assert upload_media["encoding"]["file"]["contentType"]
        url_schema = schemas["KnowledgeDocumentImportUrl"]["properties"]["url"]
        assert url_schema["maxLength"] == 2048
        authorized = schemas["AuthorizedConfigPullResponse"]["properties"]
        assert authorized["experts"]["items"]["$ref"] == "#/components/schemas/EmployeeConfigOut"
        assert authorized["solutions"]["items"]["$ref"] == "#/components/schemas/SolutionInstanceOut"
        usage_overview = schemas["UsageOverviewOut"]["properties"]
        assert usage_overview["trend"]["items"]["$ref"] == "#/components/schemas/UsageTrendPoint"
        assert usage_overview["ranking"]["items"]["$ref"] == "#/components/schemas/UsageRankingPoint"
        upload_summary_schema = schemas["UsageSummaryUploadIn"]
        assert "tenant_id" in upload_summary_schema["required"]
        upload_summary = upload_summary_schema["properties"]
        assert upload_summary["usage"]["items"]["$ref"] == "#/components/schemas/UsageSummary"
        assert upload_summary["audits"]["items"]["$ref"] == "#/components/schemas/AuditSummaryEvent"
        assert "404" in spec["paths"]["/api/manager/provider-credentials/runtime-config"]["post"]["responses"]
        mcp = spec["paths"]["/api/manager/rag/mcp"]
        assert mcp["post"]["x-protocol"] == "mcp"
        assert mcp["post"]["requestBody"]["content"]["application/json"]["examples"]
        assert mcp["post"]["responses"]["200"]["headers"]["Mcp-Session-Id"]["$ref"] == "#/components/headers/McpSessionId"
        assert {"knowledge_search", "knowledge_get"} == {item["name"] for item in spec["paths"]["/api/manager/rag/mcp"]["x-mcp-tools"]}
        transition = spec["paths"]["/api/manager/employees/{employee_id}/transitions/{transition}"]["post"]
        transition_params = {item["name"]: item for item in transition["parameters"]}
        assert "archive" in transition_params["transition"]["schema"]["enum"]
