"""会同步调用 Operator 的 Manager 接口不能跑在事件循环上。

验收时 platform-models / runtime-config 等接口在 `async def` 里同步等 Operator（3–18 秒），
整个 Manager 事件循环被占住：Agent 每个请求都要做的 /api/auth/session 核对（3 秒超时）
一起排队，用户端发消息直接 503。这些处理函数必须是普通 `def`，由 FastAPI 放进线程池执行。
"""
from __future__ import annotations

import asyncio
import inspect
import time
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import APIRouter
from fastapi.routing import APIRoute

from manager_service.hindsight_credentials import HindsightLeaseStore
from manager_service.hindsight_facade import HindsightFacade
from manager_service.routes_platform_model import build_platform_model_router
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager.test_hindsight_credentials import _Snapshot
from tests.manager.test_hindsight_facade import _app as _hindsight_app, _settings as _hindsight_settings


_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()

# 这些模块的接口（直接或经快照/模型校验）会同步请求 Operator 目录。
OPERATOR_BOUND_ROUTE_MODULES = {
    "manager_service.routes_platform_model",
    "manager_service.routes_provider",
    "manager_service.routes_snapshot",
    "manager_service.routes_hindsight",
    "manager_service.routes_recruit",
    "manager_service.routes_employee",
    "manager_service.routes_skill_market",
}


class _SlowCatalog:
    def list_platform_catalog(self, *, tenant_id: str | None = None) -> dict:
        time.sleep(0.8)  # 模拟 Operator 慢响应：同步 HTTP 客户端阻塞当前线程。
        return {"providers": [], "models": [], "model_access_configured": False}


@pytest.mark.asyncio
async def test_slow_operator_catalog_does_not_stall_other_requests() -> None:
    app = create_app(Settings(tier="manager", service_name="manager"), APIRouter())
    app.state._operator_catalog = _SlowCatalog()
    app.include_router(build_platform_model_router(_VERIFIER))
    token = sign_inmem_token(_SIGNER, "tenant-a", ["owner"], user_id="owner-a")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # 从发出慢请求开始计时：若事件循环被占住，连这里的 sleep 都要等 Operator 返回。
        started = time.perf_counter()
        slow = asyncio.create_task(
            client.get("/api/manager/platform-models", headers={"Authorization": f"Bearer {token}"})
        )
        await asyncio.sleep(0.1)
        health = await client.get("/healthz")
        elapsed = time.perf_counter() - started
        catalog = await slow

    assert health.status_code == 200
    assert catalog.status_code == 200, catalog.text
    assert elapsed < 0.5, f"/healthz answered after {elapsed:.2f}s, i.e. behind the Operator call"


def _api_routes(routes):
    """FastAPI ≥0.130 惰性挂载子路由（_IncludedRouter 占位），需要展开 original_router。"""
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
        elif (included := getattr(route, "original_router", None)) is not None:
            yield from _api_routes(included.routes)


def test_operator_bound_routes_run_in_the_threadpool() -> None:
    from manager_service.app import app

    endpoints = [
        route.endpoint
        for route in _api_routes(app.routes)
        if route.endpoint.__module__ in OPERATOR_BOUND_ROUTE_MODULES
    ]
    assert {endpoint.__module__ for endpoint in endpoints} == OPERATOR_BOUND_ROUTE_MODULES
    blocking = sorted(
        f"{endpoint.__module__}.{endpoint.__name__}"
        for endpoint in endpoints
        if inspect.iscoroutinefunction(endpoint)
    )
    # 记忆代理需要异步流式转发，已把同步授权（含快照/Operator 目录）放进线程，见下一个用例。
    assert blocking == [
        "manager_service.routes_hindsight.memory_protocol_proxy",
        "manager_service.routes_hindsight.proxy",
        "manager_service.routes_hindsight.scoped_memory_protocol_proxy",
    ]


class _SlowSnapshot(_Snapshot):
    def generate(self, ctx, *, member_id: str, employee_id: str, employee_version=None):
        time.sleep(0.3)  # 快照生成会同步读 Operator 目录；记忆代理每次请求要授权 3 次。
        return super().generate(ctx, member_id=member_id, employee_id=employee_id, employee_version=employee_version)


@pytest.mark.asyncio
async def test_hindsight_proxy_authorization_does_not_stall_other_requests() -> None:
    leases = HindsightLeaseStore(token_factory=lambda: "opaque-agent-lease")
    lease = leases.issue(
        tenant_id="tenant-1", member_id="member-1", employee_id="employee-1",
        snapshot_version="snap-1", policy={"enabled": True}, bank_id="bank-a",
    )
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"ok": True})))
    app = _hindsight_app(HindsightFacade(
        settings=_hindsight_settings(), leases=leases, client=upstream,
        principal_repository=Mock(find_user=Mock(return_value=SimpleNamespace(status="active", roles=["member"]))),
        snapshot_service=_SlowSnapshot({"enabled": True}),
    ))

    @app.get("/ping")
    async def ping() -> dict:
        return {"ok": True}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        started = time.perf_counter()
        recall = asyncio.create_task(client.post(
            "/api/manager/hindsight/v1/default/banks/bank-a/memories/recall",
            headers={"Authorization": f"Bearer {lease.token}"}, json={"query": "hello"},
        ))
        await asyncio.sleep(0.1)
        ping_response = await client.get("/ping")
        elapsed = time.perf_counter() - started
        recalled = await recall

    assert ping_response.status_code == 200
    assert recalled.status_code == 200, recalled.text
    assert elapsed < 0.5, f"/ping answered after {elapsed:.2f}s, i.e. behind memory authorization"
