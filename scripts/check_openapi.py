#!/usr/bin/env python3
"""Small dependency-free OpenAPI quality gate for the three AI Team services."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
PLACEHOLDERS = {
    "请查看接口名称了解用途",
    "执行接口摘要所述业务操作；成功响应遵循统一 envelope，失败返回 problem+json。",
}
PUBLIC_PREFIXES = ("/api/auth/",)
MINIMUM_OPERATION_COUNTS = {"operation.json": 55, "manager.json": 174}

SERVICE_OPERATION_IDS = {
    "operation_ingest_rollup",
    "operation_platform_provider_pull",
    "operation_tenant_provider_access_resolve",
    "manager_provision_tenant",
    "manager_owner_bootstrap",
    "manager_catalog_notify",
    "manager_inbox_deliver_from_operation",
}


def operations(document: dict[str, Any]):
    for path, item in document.get("paths", {}).items():
        if not path.startswith("/api/") or not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method in HTTP_METHODS and isinstance(operation, dict):
                yield path, method, operation


def resolve(schema: Any, components: dict[str, Any], seen: set[str] | None = None) -> Any:
    if not isinstance(schema, dict) or "$ref" not in schema:
        return schema
    seen = seen or set()
    ref = schema["$ref"]
    if ref in seen:
        return {}
    return resolve(components.get("schemas", {}).get(ref.rsplit("/", 1)[-1], {}), components, seen | {ref})


def has_empty_schema(schema: Any, components: dict[str, Any]) -> bool:
    schema = resolve(schema, components)
    if schema == {} or schema is None:
        return True
    if not isinstance(schema, dict):
        return False
    if schema.get("x-dynamic-json") is True:
        return False
    if schema.get("type") == "object" and schema.get("additionalProperties") is True:
        return True
    if "anyOf" in schema:
        branches = schema["anyOf"]
        non_null = [branch for branch in branches if resolve(branch, components).get("type") != "null"]
        return not non_null or any(has_empty_schema(branch, components) for branch in non_null)
    if schema.get("type") == "array":
        return has_empty_schema(schema.get("items", {}), components)
    return False


def data_schema(schema: Any, components: dict[str, Any]) -> Any:
    schema = resolve(schema, components)
    if not isinstance(schema, dict):
        return schema
    if "properties" in schema and "data" in schema["properties"]:
        return schema["properties"]["data"]
    return schema


def resolve_response(response: Any, components: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(response, dict) or "$ref" not in response:
        return response if isinstance(response, dict) else {}
    name = str(response["$ref"]).rsplit("/", 1)[-1]
    candidate = components.get("responses", {}).get(name, {})
    return candidate if isinstance(candidate, dict) else {}


def has_example(value: Any) -> bool:
    return isinstance(value, dict) and (value.get("example") is not None or bool(value.get("examples")))


def security_kind(path: str, operation: dict[str, Any]) -> str | None:
    operation_id = str(operation.get("operationId", ""))
    if path.endswith("/ping") or path.startswith(PUBLIC_PREFIXES) or path in {"/api/operation/auth/login", "/api/agent/login", "/api/agent/reset-password"}:
        return None
    if path.startswith("/api/operation/catalog/pull/") or path.startswith("/api/operation/skill-market/pull/"):
        return "service"
    if operation_id in SERVICE_OPERATION_IDS:
        return "service"
    return "bearer"


def check(path: Path) -> list[str]:
    document = json.loads(path.read_text(encoding="utf-8"))
    components = document.get("components", {})
    errors: list[str] = []
    required_schemes = {"bearerAuth"} if "agent" in path.name else {"bearerAuth", "serviceToken"}
    if not required_schemes <= set(components.get("securitySchemes", {})):
        errors.append(f"components.securitySchemes must declare {sorted(required_schemes)}")

    def scan_schema_nodes(node: Any, label: str) -> None:
        if isinstance(node, dict):
            if node == {}:
                errors.append(f"{label}: empty schema/object")
            if node.get("type") == "object" and node.get("additionalProperties") is True and node.get("x-dynamic-json") is not True:
                errors.append(f"{label}: unmarked dynamic object")
            for key, child in node.items():
                scan_schema_nodes(child, f"{label}.{key}")
        elif isinstance(node, list):
            for index, child in enumerate(node):
                scan_schema_nodes(child, f"{label}[{index}]")

    scan_schema_nodes(document.get("components", {}).get("schemas", {}), "components.schemas")
    for tag in document.get("tags", []):
        if isinstance(tag, dict) and not tag.get("description"):
            errors.append(f"tag {tag.get('name')}: missing description")
    operation_rows = list(operations(document))
    minimum_count = MINIMUM_OPERATION_COUNTS.get(path.name)
    if minimum_count is not None and len(operation_rows) < minimum_count:
        errors.append(f"{path.name}: expected at least {minimum_count} API operations, found {len(operation_rows)}")
    seen_operation_ids: set[str] = set()
    for route, method, operation in operation_rows:
        label = f"{method.upper()} {route}"
        operation_id = operation.get("operationId")
        for key in ("summary", "description", "operationId"):
            if not operation.get(key):
                errors.append(f"{label}: missing {key}")
        if operation.get("description") in PLACEHOLDERS:
            errors.append(f"{label}: placeholder description")
        if operation_id in seen_operation_ids:
            errors.append(f"{label}: duplicate operationId {operation_id}")
        if operation_id:
            seen_operation_ids.add(operation_id)
        if not operation.get("tags"):
            errors.append(f"{label}: missing tags")

        kind = security_kind(route, operation)
        expected_security = [] if kind is None else [{"serviceToken": []}] if kind == "service" else [{"bearerAuth": []}]
        if operation.get("security") != expected_security:
            errors.append(f"{label}: security must be {expected_security!r}")

        for parameter in operation.get("parameters", []):
            if not parameter.get("description"):
                errors.append(f"{label}: parameter {parameter.get('name')} missing description")
            if not has_example(parameter):
                errors.append(f"{label}: parameter {parameter.get('name')} missing example")
            if parameter.get("in") == "path" and parameter.get("required") is not True:
                errors.append(f"{label}: path parameter {parameter.get('name')} must be required")

        if "requestBody" in operation:
            body = operation["requestBody"]
            if not body.get("description") and "agent" not in path.name:
                errors.append(f"{label}: requestBody missing description")
            content = body.get("content", {})
            if not content:
                errors.append(f"{label}: requestBody has no content")
            for media, value in content.items():
                if has_empty_schema(value.get("schema"), components):
                    errors.append(f"{label}: request {media} has empty/Any schema")
                if not has_example(value):
                    errors.append(f"{label}: request {media} missing example")

        responses = operation.get("responses", {})
        if "422" not in responses and operation.get("x-protocol") != "mcp":
            errors.append(f"{label}: missing 422 response")
        if kind == "bearer" and not {"401", "403"} <= responses.keys():
            errors.append(f"{label}: missing bearer error responses")
        if kind == "service":
            if "401" not in responses:
                errors.append(f"{label}: missing service authentication response")
            if "403" in responses:
                errors.append(f"{label}: service-token route must not claim role-based 403")
        for status, raw_response in responses.items():
            response = resolve_response(raw_response, components)
            if str(status).startswith("2"):
                required_headers = {"X-Request-ID"} if "agent" in path.name else {"X-Request-ID", "X-Trace-ID"}
                if not required_headers <= set(response.get("headers", {})):
                    errors.append(f"{label}: success response {status} missing request/trace headers")
                if status == "204":
                    continue
                for media, value in response.get("content", {}).items():
                    schema = value.get("schema")
                    if media.startswith(("text/event-stream", "text/csv", "application/octet-stream", "image/", "application/pdf", "text/markdown")):
                        if has_empty_schema(schema, components) and media != "text/event-stream":
                            errors.append(f"{label}: binary/text response {status} {media} has empty schema")
                    elif has_empty_schema(data_schema(schema, components), components):
                        errors.append(f"{label}: success response {status} {media} has empty/Any data schema")
                    if not has_example(value):
                        errors.append(f"{label}: success response {status} {media} missing example")
                continue
            if str(status) in {"400", "401", "403", "404", "405", "406", "409", "410", "413", "415", "422", "429", "500", "502", "503"}:
                if str(operation_id).startswith("manager_rag_mcp_") and str(status) in {"400", "404", "405", "406", "409", "415", "500"}:
                    protocol_content = response.get("content", {}).get("application/json")
                    if not isinstance(protocol_content, dict) or not has_example(protocol_content):
                        errors.append(f"{label}: MCP protocol error {status} missing JSON-RPC example")
                    continue
                problem = response.get("content", {}).get("application/problem+json")
                if not isinstance(problem, dict) or problem.get("schema", {}).get("$ref") != "#/components/schemas/Problem":
                    errors.append(f"{label}: error response {status} must use Problem application/problem+json")
                elif not has_example(problem):
                    errors.append(f"{label}: error response {status} missing example")
                required_headers = {"X-Request-ID"} if "agent" in path.name else {"X-Request-ID", "X-Trace-ID"}
                if not required_headers <= set(response.get("headers", {})):
                    errors.append(f"{label}: error response {status} missing request/trace headers")

    def check_schema(name: str, schema: Any) -> None:
        if not isinstance(schema, dict):
            return
        if not schema.get("description"):
            errors.append(f"components.schemas.{name}: missing description")
        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for field, value in properties.items():
                if isinstance(value, dict) and not value.get("description") and "$ref" not in value:
                    errors.append(f"components.schemas.{name}.{field}: missing description")
                check_inline(f"components.schemas.{name}.{field}", value)
        check_inline(f"components.schemas.{name}", schema)

    def check_inline(label: str, schema: Any) -> None:
        if not isinstance(schema, dict):
            return
        properties = schema.get("properties", {})
        if isinstance(properties, dict):
            for field, value in properties.items():
                if isinstance(value, dict) and not value.get("description") and "$ref" not in value:
                    errors.append(f"{label}.{field}: missing description")
                check_inline(f"{label}.{field}", value)
        if schema.get("type") == "array":
            check_inline(f"{label}[]", schema.get("items"))
        for key in ("anyOf", "oneOf", "allOf"):
            for index, child in enumerate(schema.get(key, [])):
                check_inline(f"{label}.{key}[{index}]", child)

    for name, schema in components.get("schemas", {}).items():
        check_schema(name, schema)

    if "manager" in path.name:
        expected_manager_routes = {
            ("get", "/api/manager/llm/providers"), ("post", "/api/manager/llm/providers"),
            ("patch", "/api/manager/llm/providers/{provider_id}"), ("delete", "/api/manager/llm/providers/{provider_id}"),
            ("get", "/api/manager/llm/models"), ("post", "/api/manager/llm/providers/{provider_id}/models"),
            ("delete", "/api/manager/llm/models/{model_id}"),
        }
        actual = {(method, route) for route, method, _ in operations(document)}
        for method, route in sorted(expected_manager_routes - actual):
            errors.append(f"missing mounted Manager route {method.upper()} {route}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("spec", nargs="+", type=Path)
    args = parser.parse_args()
    failures = 0
    for spec in args.spec:
        errors = check(spec)
        if errors:
            failures += len(errors)
            print(f"{spec}: {len(errors)} OpenAPI quality errors", file=sys.stderr)
            for error in errors[:40]:
                print(f"  - {error}", file=sys.stderr)
            if len(errors) > 40:
                print(f"  ... {len(errors) - 40} more", file=sys.stderr)
        else:
            print(f"{spec}: OK")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
