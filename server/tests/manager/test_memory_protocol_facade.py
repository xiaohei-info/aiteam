from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from manager_service.memory_protocol_facade import MemoryProtocolFacade
from shared.contracts.tenancy import TenantContext
from shared.errors import install_exception_handlers


class _Memory:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def runtime_context(self, ctx, *, employee_id):
        self.calls.append(("runtime", {"employee_id": employee_id}))
        return {"bank_id": "aiteam-" + "a" * 32}

    def recall(self, ctx, *, employee_id, query, limit):
        self.calls.append(("recall", {"employee_id": employee_id, "query": query, "limit": limit}))
        return {"results": [{"id": "m1", "text": "answer"}]}

    def retain(self, ctx, *, employee_id, content, metadata):
        self.calls.append(("retain", {"employee_id": employee_id, "content": content, "metadata": metadata}))
        return {"success": True, "async": True, "operation_id": f"op-{len(self.calls)}"}


def _app(memory: _Memory) -> FastAPI:
    app = FastAPI()
    install_exception_handlers(app)
    facade = MemoryProtocolFacade(memory)  # type: ignore[arg-type]

    @app.api_route("/memory/{employee_id}/{path:path}", methods=["GET", "POST"])
    async def proxy(request: Request, employee_id: str, path: str):
        return await facade.proxy(
            request,
            path,
            ctx=TenantContext(tenant_id="tenant-1", user_id="member-1"),
            employee_id=employee_id,
        )

    return app


def test_recall_uses_manager_memory_service_and_ignores_plugin_bank():
    memory = _Memory()
    response = TestClient(_app(memory)).post(
        "/memory/employee-1/v1/default/banks/attacker-bank/memories/recall",
        headers={"Content-Type": "application/json"},
        json={"query": "hello", "max_tokens": 512},
    )
    assert response.status_code == 200
    assert response.json() == {"results": [{"id": "m1", "text": "answer"}]}
    assert memory.calls == [("recall", {"employee_id": "employee-1", "query": "hello", "limit": 2})]


def test_retain_translates_hindsight_batch_to_existing_manager_retain():
    memory = _Memory()
    response = TestClient(_app(memory)).post(
        "/memory/employee-1/v1/default/banks/any-bank/memories",
        headers={"Content-Type": "application/json"},
        json={"items": [{"content": "one"}, {"content": "two", "context": "ctx"}]},
    )
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["async"] is True
    assert response.json()["operation_id"] == "op-1"
    assert [call[1]["employee_id"] for call in memory.calls] == ["employee-1", "employee-1"]
    assert memory.calls[1][1]["metadata"]["context"] == "ctx"


def test_profile_authorizes_through_memory_service_and_uses_derived_bank():
    memory = _Memory()
    response = TestClient(_app(memory)).get(
        "/memory/employee-1/v1/default/banks/any-bank/profile",
    )
    assert response.status_code == 200
    assert response.json()["bank_id"] == "aiteam-" + "a" * 32
    assert memory.calls == [("runtime", {"employee_id": "employee-1"})]
