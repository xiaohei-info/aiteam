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

from shared.app_factory import create_app
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
    return create_app(settings, APIRouter(prefix=f"/api/{tier}"))


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
    assert f"{tier_dist} SPA" in response.text
