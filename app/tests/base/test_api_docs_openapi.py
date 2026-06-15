"""Tests for the auto-extracted API docs (Swagger UI + OpenAPI index).

The backend has no web framework, so the OpenAPI document is built by
statically scanning the hand-written routers. These tests pin:
- the extractor finds a healthy number of real routes,
- known endpoints across every router family are present with correct methods,
- no garbage literals leak into the path set,
- the two GET routes (/api/docs, /api/openapi.json) are wired into handle_get.
"""
import io
import json
import re
from urllib.parse import urlparse

import api.routes as routes
from api import api_docs


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def body_text(self):
        return self.wfile.getvalue().decode("utf-8")

    def json_body(self):
        return json.loads(self.body_text())


class TestOpenApiSpec:
    def test_spec_has_openapi_structure(self):
        spec = api_docs.build_openapi_spec()
        assert spec["openapi"].startswith("3.")
        assert spec["info"]["title"]
        assert isinstance(spec["paths"], dict)

    def test_finds_a_healthy_number_of_routes(self):
        paths = api_docs.build_openapi_spec()["paths"]
        # ~270 paths today across all routers; guard against the extractor
        # silently breaking and emitting almost nothing.
        assert len(paths) > 150, f"only {len(paths)} paths extracted — extractor likely broke"

    def test_known_endpoints_present_with_methods(self):
        paths = api_docs.build_openapi_spec()["paths"]
        expected = {
            ("/api/team/workbench", "get"),          # router_team exact match
            ("/api/team/runs", "post"),              # router_team POST
            ("/api/team/runs/{id}/stream", "get"),   # prefix + endswith reconstruction
            ("/api/team/employees/{id}", "patch"),   # prefix match -> {id}
            ("/api/auth/refresh", "post"),           # auth dispatch (absolute) in routes.py
            ("/api/me", "get"),                      # auth GET dispatch
            ("/api/insights", "get"),                # base handle_get route
            ("/api/kanban/boards", "get"),           # kanban_bridge enclosing-function
            ("/api/system-admin/", None),            # at least one system-admin route exists
        }
        for path, method in expected:
            if method is None:
                assert any(p.startswith(path) for p in paths), f"no path under {path}"
                continue
            assert path in paths, f"missing path {path}"
            assert method in paths[path], f"{path} missing method {method}; has {sorted(paths[path])}"

    def test_paths_are_clean(self):
        paths = api_docs.build_openapi_spec()["paths"]
        for p in paths:
            assert p.startswith("/api/"), f"non-api path leaked: {p!r}"
            assert " " not in p and "%" not in p, f"garbage literal leaked: {p!r}"
            # only {id} placeholders are emitted
            for ph in re.findall(r"\{(\w+)\}", p):
                assert ph == "id", f"unexpected placeholder in {p!r}"

    def test_operations_carry_tag_and_responses(self):
        paths = api_docs.build_openapi_spec()["paths"]
        op = paths["/api/team/workbench"]["get"]
        assert op["tags"] == ["team"]
        assert "200" in op["responses"]

    def test_id_paths_declare_path_parameter(self):
        paths = api_docs.build_openapi_spec()["paths"]
        op = paths["/api/team/employees/{id}"]["patch"]
        assert any(prm["name"] == "id" and prm["in"] == "path" for prm in op["parameters"])


class TestSwaggerUiHtml:
    def test_html_references_swagger_and_spec_url(self):
        html = api_docs.swagger_ui_html()
        assert "swagger-ui" in html
        assert "/api/openapi.json" in html
        assert "SwaggerUIBundle" in html


class TestRouteWiring:
    def test_openapi_json_route(self):
        handler = _FakeHandler()
        routes.handle_get(handler, urlparse("http://example.com/api/openapi.json"))
        assert handler.status == 200
        assert "application/json" in handler.headers.get("Content-Type", "")
        assert handler.json_body()["openapi"].startswith("3.")

    def test_docs_route_serves_html(self):
        handler = _FakeHandler()
        routes.handle_get(handler, urlparse("http://example.com/api/docs"))
        assert handler.status == 200
        assert "text/html" in handler.headers.get("Content-Type", "")
        assert "swagger-ui" in handler.body_text()
