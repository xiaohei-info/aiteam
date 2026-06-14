"""Auto-generated API index + Swagger UI for the AI Team backend.

The backend has no web framework — routing is hand-written string matching in
``api/routes.py``, ``api/kanban_bridge.py`` and ``team_panel/api_team/router_*.py``.
There is therefore no declarative route registry for a tool like FastAPI's
built-in docs / flasgger / apispec to introspect. Instead of migrating 200+
routes to a framework (large, risky refactor), this module *statically scans*
the router source files for their route literals and builds a path-level
OpenAPI document. It is an **endpoint index**, not a full contract: request /
response body schemas are not present in the source, so they are not emitted.

Served read-only at:
  - ``GET /api/openapi.json`` — the generated OpenAPI document
  - ``GET /api/docs``         — Swagger UI (loads swagger-ui-dist from CDN)

Zero changes to existing route code; the only base-file change is a small
hook in ``api/routes.handle_get``.
"""
from __future__ import annotations

import re
from pathlib import Path

_APP_DIR = Path(__file__).resolve().parent.parent

# Files whose route's HTTP method is determined by the enclosing dispatch
# function (handle_get -> GET, ...). Maps file -> {function_name: method}.
_ENCLOSING_FUNCTION_FILES: dict[str, dict[str, str]] = {
    "api/routes.py": {
        "handle_get": "get",
        "handle_post": "post",
        "handle_patch": "patch",
        "handle_delete": "delete",
        "handle_put": "put",
    },
    "api/kanban_bridge.py": {
        "handle_kanban_get": "get",
        "handle_kanban_post": "post",
        "handle_kanban_patch": "patch",
        "handle_kanban_delete": "delete",
    },
}

# Files whose routes carry an explicit ``method == "VERB"`` guard next to a
# prefix-stripped match helper. Maps file -> base prefix to prepend (the
# dispatch strips it before calling the router). ``""`` means paths are already
# absolute (e.g. the auth dispatch inside routes.py).
_METHOD_PAIRED_FILES: dict[str, str] = {
    "api/routes.py": "",
    "team_panel/api_team/router_team.py": "/api/team",
    "team_panel/api_team/router_enterprise_admin.py": "/api/enterprise-admin",
    "team_panel/api_team/router_system_admin.py": "/api/system-admin",
}

_TAG_BY_PREFIX = [
    ("/api/team", "team"),
    ("/api/enterprise-admin", "enterprise-admin"),
    ("/api/system-admin", "system-admin"),
    ("/api/auth", "auth"),
    ("/api/kanban", "kanban"),
    ("/api/mcp", "mcp"),
]

_VALID_METHODS = ("get", "post", "patch", "delete", "put")

# A literal that looks like an API path: "/api/..." with no whitespace.
_ABS_API_LITERAL = re.compile(r'"(/api/[A-Za-z0-9_./{}-]*)"')
# `_match_exact(var, "/x")` / `_match_prefix(var, "/x/")`
_MATCH_CALL = re.compile(r'_match_(exact|prefix)\(\s*\w+\s*,\s*"([^"]+)"')
# `... .endswith("/seg")` — used to reconstruct sub-routes under a prefix match.
_ENDSWITH = re.compile(r'\.endswith\(\s*"(/[^"]+)"')
# `method == "VERB"`
_METHOD_EQ = re.compile(r'method\s*==\s*"(\w+)"')


def _normalize(path: str, is_prefix: bool, suffix: str | None) -> str:
    """Turn a raw route literal into an OpenAPI path template.

    A ``_match_prefix`` literal ends with ``/`` and captures a trailing id, so
    ``/runs/`` becomes ``/runs/{id}``; an optional ``.endswith`` suffix turns it
    into ``/runs/{id}/stream``.
    """
    path = path.rstrip("/") if is_prefix else path
    if is_prefix:
        path = f"{path}/{{id}}"
    if suffix:
        path = f"{path}{suffix}"
    return path


def _add(routes: dict[str, set[str]], method: str, path: str) -> None:
    method = method.lower()
    if method not in _VALID_METHODS or not path.startswith("/api/"):
        return
    routes.setdefault(path, set()).add(method)


def _scan_enclosing_function(text: str, func_to_method: dict[str, str], routes: dict[str, set[str]]) -> None:
    """Within each `def handle_*` block, every "/api/..." literal is a route
    served with that function's HTTP method."""
    func_re = re.compile(r"^def (\w+)\(", re.MULTILINE)
    matches = list(func_re.finditer(text))
    for i, m in enumerate(matches):
        name = m.group(1)
        method = func_to_method.get(name)
        if not method:
            continue
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        for lit in _ABS_API_LITERAL.finditer(text, start, end):
            _add(routes, method, lit.group(1))


def _scan_method_paired(text: str, prefix: str, routes: dict[str, set[str]]) -> None:
    """Pair each match-helper / absolute literal with the HTTP method declared
    on the same logical line (`method == "GET" and _match_exact(sub, "/x")`),
    falling back to the nearest `method ==` within a small window."""
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        methods = _METHOD_EQ.findall(line)
        if not methods:
            # Decoupled form: `var = _match_prefix(...)` on its own line. Look a
            # few lines ahead for the method guard that consumes the variable.
            if _MATCH_CALL.search(line):
                window = " ".join(lines[idx : idx + 8])
                methods = _METHOD_EQ.findall(window)
            if not methods:
                continue

        suffix_match = _ENDSWITH.search(line) or _ENDSWITH.search(" ".join(lines[idx : idx + 4]))
        suffix = suffix_match.group(1) if suffix_match else None

        for kind, raw in _MATCH_CALL.findall(line):
            path = _normalize(raw, is_prefix=(kind == "prefix"), suffix=suffix)
            full = path if path.startswith("/api/") else f"{prefix}{path}"
            for method in methods:
                _add(routes, method, full)

        if prefix == "":  # absolute-path dispatch (auth) inside routes.py
            for lit in _ABS_API_LITERAL.finditer(line):
                for method in methods:
                    _add(routes, method, lit.group(1))


def _collect_routes() -> dict[str, set[str]]:
    routes: dict[str, set[str]] = {}
    for rel, func_map in _ENCLOSING_FUNCTION_FILES.items():
        text = (_APP_DIR / rel).read_text(encoding="utf-8")
        _scan_enclosing_function(text, func_map, routes)
    for rel, prefix in _METHOD_PAIRED_FILES.items():
        text = (_APP_DIR / rel).read_text(encoding="utf-8")
        _scan_method_paired(text, prefix, routes)
    return routes


def _tag_for(path: str) -> str:
    for prefix, tag in _TAG_BY_PREFIX:
        if path.startswith(prefix):
            return tag
    return "other"


def _version() -> str:
    try:
        from api.updates import WEBUI_VERSION
        return str(WEBUI_VERSION)
    except Exception:
        return "dev"


def build_openapi_spec() -> dict:
    """Build a path-level OpenAPI 3.0 document from the router sources."""
    routes = _collect_routes()
    paths: dict[str, dict] = {}
    tags_seen: set[str] = set()

    for path in sorted(routes):
        tag = _tag_for(path)
        tags_seen.add(tag)
        params = []
        if "{id}" in path:
            params = [{
                "name": "id", "in": "path", "required": True,
                "schema": {"type": "string"},
                "description": "Path identifier (auto-detected from prefix match).",
            }]
        ops: dict[str, dict] = {}
        for method in sorted(routes[path]):
            op = {
                "tags": [tag],
                "summary": f"{method.upper()} {path}",
                "description": "Auto-extracted from router source. Request/response "
                               "schemas are not declared in code and are omitted.",
                "responses": {"200": {"description": "OK"}},
            }
            if params:
                op["parameters"] = params
            ops[method] = op
        paths[path] = ops

    return {
        "openapi": "3.0.3",
        "info": {
            "title": "AI Team Backend API (auto-extracted index)",
            "version": _version(),
            "description": (
                "Endpoint index statically extracted from the hand-written "
                "routers (no web framework in use). Paths and HTTP methods are "
                "accurate; request/response body schemas are **not** present in "
                "source and are therefore not documented here. For the frozen "
                "north-API contract see the design docs under `docs/`."
            ),
        },
        "tags": [{"name": t} for t in sorted(tags_seen)],
        "paths": paths,
    }


_SWAGGER_UI_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>AI Team API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/api/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        docExpansion: "none",
        defaultModelsExpandDepth: -1,
      });
    };
  </script>
</body>
</html>
"""


def swagger_ui_html() -> str:
    """Return the Swagger UI page (loads swagger-ui-dist from CDN in browser)."""
    return _SWAGGER_UI_HTML
