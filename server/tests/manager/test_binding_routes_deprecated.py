"""技能 / 连接器旁路绑定接口已弃用（设计 2026-11-22 §3.1）：OpenAPI 标 deprecated；知识 / 记忆 / prompt 版本不受影响。"""

from fastapi import FastAPI

from manager_service.routes_employee_bindings import build_employee_bindings_router


def test_skill_and_connector_bindings_are_marked_deprecated():
    app = FastAPI()
    app.include_router(build_employee_bindings_router(verifier=None))
    paths = app.openapi()["paths"]
    for prefix in ("skill-bindings", "connector-bindings"):
        operations = [op for path, item in paths.items() if f"/{prefix}" in path for op in item.values()]
        assert operations and all(op.get("deprecated") is True for op in operations), prefix
    for prefix in ("knowledge-bindings", "memory-setting", "prompt-versions"):
        operations = [op for path, item in paths.items() if f"/{prefix}" in path for op in item.values()]
        assert operations and not any(op.get("deprecated") for op in operations), prefix
