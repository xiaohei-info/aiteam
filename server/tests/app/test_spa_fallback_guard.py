"""SPA fallback guard for three-tier app assembly (L1).

Unknown `/api/*` paths must keep the backend error contract instead of returning an
SPA `index.html`, while ordinary frontend routes may still fall back to the SPA.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from shared.app_factory import create_app, mount_frontend
from shared.config import Settings

TIERS = ("operation", "manager", "agent")
KNOWN_OPERATION_REGRESSION_PATHS = (
    "/api/operation/catalog",
    "/api/operation/rollups/board",
)


def _dist_dir(tier: str) -> Path:
    return Path(__file__).resolve().parents[3] / "web" / tier / "dist"


def _app_for_tier(tier: str):
    settings = Settings(tier=tier, service_name=f"test-{tier}", log_level="WARNING")
    app = create_app(settings, APIRouter(prefix=f"/api/{tier}"))
    mount_frontend(app, tier)
    return app


@pytest.fixture(params=TIERS)
def tier_dist(request):
    tier = request.param
    dist = _dist_dir(tier)
    created = not dist.exists()
    if created:
        (dist / "assets").mkdir(parents=True, exist_ok=True)
        (dist / "index.html").write_text(
            f"<!doctype html><html>{tier} SPA</html>", encoding="utf-8"
        )
        (dist / "assets" / "app.js").write_text("console.log('spa');", encoding="utf-8")
    yield tier
    if created:
        shutil.rmtree(dist, ignore_errors=True)


@pytest.mark.parametrize("path", KNOWN_OPERATION_REGRESSION_PATHS)
def test_known_operation_api_paths_do_not_return_spa_html(path):
    dist = _dist_dir("operation")
    created = not dist.exists()
    if created:
        (dist / "assets").mkdir(parents=True, exist_ok=True)
        (dist / "index.html").write_text("<!doctype html><html>operation SPA</html>", encoding="utf-8")
    try:
        response = TestClient(_app_for_tier("operation")).get(path)
    finally:
        if created:
            shutil.rmtree(dist, ignore_errors=True)

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "text/html" not in response.headers["content-type"]
    assert "<!doctype html" not in response.text.lower()


def test_unknown_api_paths_do_not_return_spa_html(tier_dist):
    response = TestClient(_app_for_tier(tier_dist)).get(f"/api/{tier_dist}/__missing_route__")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "<!doctype html" not in response.text.lower()


def test_frontend_routes_still_fallback_to_spa(tier_dist):
    response = TestClient(_app_for_tier(tier_dist)).get("/settings/profile")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    # fallback 必须原样返回 dist/index.html——不比对固定占位文本：
    # dist 可能是 fixture 造的 stub，也可能是本机真实构建产物（环境无关）。
    index_html = (_dist_dir(tier_dist) / "index.html").read_text(encoding="utf-8")
    assert response.text == index_html


def test_get_api_route_registered_before_mount_frontend_is_reachable(tier_dist):
    """#257 回归：在 mount_frontend 之前注册的 GET API 路由必须可达。

    旧 bug：create_app 内部先挂 catch-all `GET /{full_path:path}`，各端之后才
    include auth_router 等 → 后注册的 GET API 路由（如 jwks）被遮蔽 → 404。
    修复后：mount_frontend 在所有 include_router 之后最后调用，catch-all 永远在后。
    """
    from fastapi import APIRouter

    settings = Settings(tier=tier_dist, service_name=f"test-{tier_dist}", log_level="WARNING")
    app = create_app(settings, APIRouter(prefix=f"/api/{tier_dist}"))

    # 在 mount_frontend 之前注册一个 GET 路由（模拟 auth_router 的 jwks 等路由）
    api_router = APIRouter(prefix=f"/api/{tier_dist}")

    @api_router.get("/late-route")
    async def _late():
        return {"ok": True}

    app.include_router(api_router)
    # mount_frontend 在最后——catch-all 永远在所有 API 路由之后
    mount_frontend(app, tier_dist)

    response = TestClient(app).get(f"/api/{tier_dist}/late-route")
    assert response.status_code == 200
    assert response.json()["ok"] is True
