"""shared/app_factory.py create_app + mount_frontend 分支测试。

覆盖：healthz/readyz 端点返回体、expose_public_docs True/False 分支、
mount_frontend 挂载静态资源 + SPA 回退（用真实临时 dist 目录，测试后清理）。
"""

import shutil
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from shared.app_factory import create_app, mount_frontend
from shared.config import Settings


# 与 mount_frontend 内部计算对齐：server/../web/<tier>/dist
_DIST = Path(__file__).resolve().parent.parent.parent.parent / "web" / "operation" / "dist"


def _settings(docs: bool = True, tier="operation") -> Settings:
    return Settings(
        tier=tier,
        service_name=f"test-{tier}",
        log_level="WARNING",
        expose_public_docs=docs,
    )


def _empty_router(prefix="/api/operation") -> APIRouter:
    return APIRouter(prefix=prefix)


def test_healthz_and_readyz():
    app = create_app(_settings(), _empty_router())
    client = TestClient(app)
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "test-operation"

    r2 = client.get("/readyz")
    assert r2.status_code == 200
    assert r2.json()["status"] == "ready"


def test_docs_enabled():
    app = create_app(_settings(docs=True), _empty_router())
    client = TestClient(app)
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_docs_disabled():
    """expose_public_docs=False -> docs_url/redoc_url=None -> /docs 404."""
    app = create_app(_settings(docs=False), _empty_router())
    client = TestClient(app)
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404


@pytest.fixture
def _dist_dir():
    """临时创建 web/operation/dist，测试后清理。"""
    created = not _DIST.exists()
    if created:
        (_DIST / "assets").mkdir(parents=True, exist_ok=True)
        (_DIST / "index.html").write_text("<!doctype html><html>SPA</html>", encoding="utf-8")
        (_DIST / "assets" / "app.js").write_text("console.log('app');", encoding="utf-8")
    yield _DIST
    if created:
        shutil.rmtree(_DIST, ignore_errors=True)


def test_mount_frontend_serves_spa(_dist_dir):
    """有 dist 产物时 mount_frontend 挂载静态资源 + SPA 回退。"""
    assert _DIST.exists()
    app = create_app(_settings(), _empty_router())
    mount_frontend(app, "operation")
    client = TestClient(app)

    # 根路径 -> index.html
    r = client.get("/")
    assert r.status_code == 200
    assert "SPA" in r.text

    # 任意前端路由 -> SPA 回退 index.html
    r2 = client.get("/some/frontend/route")
    assert r2.status_code == 200
    assert "SPA" in r2.text

    # 静态资源
    r3 = client.get("/assets/app.js")
    assert r3.status_code == 200
    assert "app" in r3.text

    # API / 健康端点仍走具体路由，不被 SPA 回退吞掉
    assert client.get("/healthz").json()["status"] == "ok"


def test_mount_frontend_does_not_fallback_for_unknown_api_paths(_dist_dir):
    """未知 API 路径必须返回 problem+json 404，不能被 SPA 回退吞成 index.html。"""
    app = create_app(_settings(), _empty_router())
    mount_frontend(app, "operation")
    client = TestClient(app)

    response = client.get("/api/operation/catalog")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "text/html" not in response.headers["content-type"]
    assert response.json()["code"] == "not_found"
    assert "SPA" not in response.text


def test_mount_frontend_no_dist_skips():
    """无 dist 产物时 mount_frontend 跳过挂载（早退分支）。"""
    if _DIST.exists():
        pytest.skip("dist 产物已存在，无法验证跳过分支")
    app = create_app(_settings(tier="manager"), _empty_router(prefix="/api/manager"))
    mount_frontend(app, "manager")
    client = TestClient(app)
    # 无 SPA 挂载 -> 未知路径 404
    assert client.get("/some/route").status_code == 404


def test_unknown_api_path_without_dist_returns_problem_json():
    """即使没有前端 dist，框架级 404 也必须保持 problem+json。"""
    if _DIST.exists():
        pytest.skip("dist 产物已存在，无法验证无 SPA 挂载分支")
    app = create_app(_settings(tier="manager"), _empty_router(prefix="/api/manager"))
    client = TestClient(app)

    response = client.get("/api/manager/__missing_route__")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"
