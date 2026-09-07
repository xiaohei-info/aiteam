"""Opt-in native integration gate; never connects to an ambient Hindsight URL."""
from datetime import datetime, timedelta, timezone
import asyncio
import base64
import json
import os
import subprocess
import time
from dataclasses import replace

import httpx
import pytest

from manager_service.hindsight_client import HindsightClient
from manager_service.memory_retention_repository import MemoryRetentionRepository
from manager_service.memory_retention_service import MemoryRetentionService
from manager_service.memory_service import MemoryService
from manager_service.routes_memory_items import build_memory_items_router
from tests.manager.test_memory_policy_pg import memory_pg
from tests.manager.test_hindsight_credentials import _settings

pytestmark = pytest.mark.integration


class NativeFixtureTransport(httpx.BaseTransport, httpx.AsyncBaseTransport):
    """Mac and Docker do not share a Unix kernel; exec bridges bytes, not native semantics."""
    def __init__(self, container):
        self.container = container

    def handle_request(self, request):
        wire = json.dumps({"method": request.method, "path": request.url.raw_path.decode(),
                           "body": base64.b64encode(request.read()).decode(), "headers": dict(request.headers)})
        program = """import base64,json,sys,httpx
r=json.load(sys.stdin)
with httpx.Client(transport=httpx.HTTPTransport(uds='/fixture/native.sock'),timeout=10) as c:
 o=c.request(r['method'],'http://fixture'+r['path'],content=base64.b64decode(r['body']),headers=r['headers'])
 print(json.dumps({'status':o.status_code,'body':base64.b64encode(o.content).decode()}))
"""
        result = subprocess.run(["docker", "exec", "-i", self.container, "/app/api/.venv/bin/python", "-c", program],
                                input=wire, capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, "Isolated native transport failed"
        output = json.loads(result.stdout)
        return httpx.Response(output["status"], content=base64.b64decode(output["body"]), headers={"Content-Type":"application/json"})

    async def handle_async_request(self, request):
        return await asyncio.to_thread(self.handle_request, request)


def test_manager_routes_pg_ledger_and_approved_native_http_end_to_end(memory_pg):
    container = os.getenv("AITEAM_S04_NATIVE_CONTAINER")
    if not container:
        pytest.skip("Explicit isolated S04 native container required; no ambient URL fallback")
    assert container == "aiteam-s04-manager-native"
    f = memory_pg
    settings = replace(_settings(), base_url="http://s04-native-fixture", token="synthetic-fixture-only", bank_id_mode="scoped",
                       recall_path="/v1/default/banks/{bank_id}/memories/recall",
                       retain_path="/v1/default/banks/{bank_id}/memories",
                       delete_path="/v1/default/banks/{bank_id}/memories/{memory_id}")
    with httpx.Client(transport=NativeFixtureTransport(container)) as native:
        backend = HindsightClient(settings, client=native, router=f.router)
        repo = MemoryRetentionRepository(f.router, f.admin_url)
        repo.tenant_ids_due = lambda _tenant=None: [f.ctx.tenant_id]
        clock = [datetime.now(timezone.utc)]
        retention = MemoryRetentionService(repo, backend, now=lambda: clock[0])
        runtime_service = f.app.state._hindsight_runtime_service
        runtime_service._retention, runtime_service._banks = retention, backend
        facade = f.app.state._hindsight_facade
        facade._retention, facade.settings = retention, settings
        facade._client = httpx.AsyncClient(transport=NativeFixtureTransport(container))
        f.app.state._memory_service = MemoryService(snapshot=f.snapshot, backend=backend, retention_service=retention)
        f.app.include_router(build_memory_items_router(f.app.state._token_verifier))
        setting = f.base + "/memory-setting"
        f.client.patch(setting, headers=f.headers(), json={"retention_days": 1}).raise_for_status()
        def lease():
            result = f.client.post("/api/manager/hindsight/runtime-config", headers=f.headers(),
                                  json={"employee_id":f.eid,"client_protocol":"aiteam-memory-v1"})
            assert result.status_code == 200, result.text
            assert result.json()["data"]["retention_mode"] == "fact_only"
            return result.json()["data"]
        runtime = lease()
        bank = runtime["bank_id"]
        path = f"/api/manager/hindsight/v1/default/banks/{bank}/memories"
        headers = {"Authorization":"Bearer " + runtime["token"]}
        body = {"items":[{"content":"S04_OLD_NATIVE_MARKER", "timestamp":"2099-01-01T00:00:00Z", "metadata":{"source":"synthetic-native"}}], "operation_id":"same-caller-operation"}
        accepted_response = f.client.post(path, headers=headers, json=body)
        assert accepted_response.status_code == 200, accepted_response.text
        op = accepted_response.json()["operation_id"]
        assert set(accepted_response.json()) == {"success", "bank_id", "operation_id", "async"}
        def reconcile(operation):
            for _ in range(60):
                with f.router.session(f.ctx) as s:
                    s.execute("UPDATE memory_acceptance SET next_attempt=now() WHERE operation_id=%s", (operation,))
                retention.maintain_once()
                with f.router.session(f.ctx) as s:
                    state = s.execute("SELECT operation_state FROM memory_acceptance WHERE operation_id=%s", (operation,)).fetchone()[0]
                if state == "completed": return
                assert state in {"pending", "processing"}
                time.sleep(0.1)
            pytest.fail("Native asynchronous acceptance did not settle")
        reconcile(op)
        recalled = f.client.post(path+"/recall", headers=headers, json={"query":"S04 native fixture"})
        assert recalled.status_code == 200, recalled.text
        assert recalled.json()["results"] and "S04_OLD_NATIVE_MARKER" in recalled.text
        assert all(set(item) == {"id", "text", "type"} for item in recalled.json()["results"])
        mid = recalled.json()["results"][0]["id"]
        item = backend.retention_request(bank, f"memories/{mid}")
        # Pinned native engine/memories/pg/curation.py returns a flat detail view.
        document = item["document_id"]
        row = repo.get(f.ctx, bank_id=bank, document_id=document)
        assert row["accepted_at"].year != 2099
        assert f.client.post(path, headers=headers, json=body).status_code == 200
        assert repo.get(f.ctx, bank_id=bank, document_id=document)["accepted_at"] == row["accepted_at"]
        listing = f.client.get("/api/manager/memories", headers=f.headers(), params={"employee_id": f.eid})
        assert listing.status_code == 200 and "S04_OLD_NATIVE_MARKER" in listing.text and "synthetic-native" in listing.text, listing.text
        edited = f.client.patch(f"/api/manager/memories/{mid}", headers=f.headers(), params={"employee_id": f.eid}, json={"text":"S04_EDITED_NATIVE_MARKER"})
        assert edited.status_code == 200, edited.text
        f.client.patch(setting, headers=f.headers(), json={"retention_days":None}).raise_for_status()
        clock[0] = row["expires_at"] + timedelta(seconds=1)
        runtime = lease(); headers = {"Authorization":"Bearer " + runtime["token"]}
        assert f.client.post(path, headers=headers, json=body).status_code == 403
        assert f.client.patch(f"/api/manager/memories/{mid}", headers=f.headers(), params={"employee_id": f.eid}, json={"state":"valid"}).status_code == 403
        fresh = f.client.post(path, headers=headers, json={"items":[{"content":"S04_FRESH_NATIVE_MARKER"}]})
        assert fresh.status_code == 200, fresh.text
        reconcile(fresh.json()["operation_id"])
        for _ in range(3):
            with f.router.session(f.ctx) as s:
                s.execute("UPDATE memory_acceptance SET next_attempt=now() WHERE operation_id=%s", (op,))
            retention.maintain_once()
        assert repo.get(f.ctx, bank_id=bank, document_id=document)["cleanup_state"] == "cleaned"
        invalidated = backend.retention_request(bank, f"memories/{mid}")
        assert invalidated["state"] == "invalidated"
        final = f.client.post(path+"/recall", headers=headers, json={"query":"S04 native fixture"})
        assert final.status_code == 200 and "S04_FRESH_NATIVE_MARKER" in final.text
        assert "S04_OLD_NATIVE_MARKER" not in final.text and "S04_EDITED_NATIVE_MARKER" not in final.text
        unsupported = f.client.post(path+"/recall", headers=headers, json={"query":"fixture","include":{"chunks":{}}})
        assert unsupported.status_code == 403 and unsupported.json()["code"] == "memory_retention_option_unsupported"
        asyncio.run(facade._client.aclose())
