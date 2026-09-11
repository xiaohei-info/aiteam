"""shared/app_factory.py create_app + mount_frontend 分支测试。

覆盖：healthz/readyz 端点返回体、expose_public_docs True/False 分支、
mount_frontend 挂载静态资源 + SPA 回退（用真实临时 dist 目录，测试后清理）。
"""

import logging
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from shared.app_factory import create_app, mount_frontend
from shared.config import Settings
from shared.observability import RequestMetrics, _ContextFormatter, get_propagation_headers


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


def test_production_rejects_public_openapi_docs():
    with pytest.raises(ValueError, match="disable public OpenAPI docs"):
        create_app(_settings().model_copy(update={"aiteam_env": "production"}), _empty_router())


def test_production_readiness_requires_app_rw_role(monkeypatch):
    monkeypatch.delenv("AITEAM_COMPOSE_MODE", raising=False)
    app = create_app(
        _settings(docs=False).model_copy(update={
            "aiteam_env": "production",
            "db_url": "postgresql://app_rw@readyz.test/operation",
            "admin_db_url": "postgresql://admin@readyz.test/operation",
        }),
        _empty_router(),
    )
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = ("admin", "admin", True, True)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        response = TestClient(app).get("/readyz")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"


def test_production_hides_openapi_with_public_docs_disabled():
    app = create_app(_settings(docs=False).model_copy(update={"aiteam_env": "production"}), _empty_router())
    assert TestClient(app).get("/openapi.json").status_code == 404


def test_production_compose_control_plane_is_rejected(monkeypatch):
    monkeypatch.setenv("AITEAM_COMPOSE_MODE", "1")
    with pytest.raises(ValueError, match="control-plane Docker Compose is unsupported"):
        create_app(_settings(docs=False).model_copy(update={"aiteam_env": "production"}), _empty_router())


def test_healthz_and_readyz():
    app = create_app(
        _settings().model_copy(update={"db_url": "postgresql://app_rw@readyz.test/operation", "admin_db_url": "postgresql://readyz.test/operation"}),
        _empty_router(),
    )
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = ("enterprise_account",)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        client = TestClient(app)
        r = client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "test-operation"

        r2 = client.get("/readyz")
        assert r2.status_code == 200
        assert r2.json()["status"] == "ready"
    connect.assert_called_once_with(
        "postgresql://app_rw@readyz.test/operation", autocommit=True, connect_timeout=5,
    )


def test_healthz_and_readyz_follow_current_app_state_settings():
    """Rebinding the injected app state updates health/readiness decisions."""
    configured = _settings(tier="manager").model_copy(
        update={
            "service_name": "configured-manager",
            "db_url": "postgresql://readyz.test/manager",
            "admin_db_url": "postgresql://admin.test/manager",
        }
    )
    app = create_app(configured, _empty_router(prefix="/api/manager"))
    original_state = dict(app.state._state)
    app.state.settings = configured.model_copy(update={"service_name": "rebound-manager"})
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = ("tenant_registry",)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        client = TestClient(app)

        assert client.get("/healthz").json()["service"] == "rebound-manager"
        assert client.get("/readyz").status_code == 200
        assert client.get("/readyz").json()["service"] == "rebound-manager"

        app.state._state.clear()
        app.state._state.update(original_state)
        assert client.get("/healthz").json()["service"] == "configured-manager"
        restored = client.get("/readyz")
        assert restored.status_code == 200
        assert restored.json()["status"] == "ready"

    assert connect.call_count == 6


def test_readyz_without_local_database_is_not_ready():
    app = create_app(_settings(tier="manager"), _empty_router(prefix="/api/manager"))
    response = TestClient(app).get("/readyz")
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "service_unavailable"


def test_readyz_unreachable_database_is_not_ready():
    app = create_app(
        _settings(tier="manager").model_copy(update={
            "db_url": "postgresql://unreachable.test/manager",
            "admin_db_url": "postgresql://admin.test/manager",
        }),
        _empty_router(prefix="/api/manager"),
    )
    with patch("psycopg.connect", side_effect=OSError("private DSN details")):
        response = TestClient(app).get("/readyz")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"
    assert "private DSN details" not in response.text


def test_readyz_missing_schema_is_not_ready():
    app = create_app(
        _settings().model_copy(update={"db_url": "postgresql://app_rw@readyz.test/operation", "admin_db_url": "postgresql://readyz.test/operation"}),
        _empty_router(),
    )
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = (None,)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        response = TestClient(app).get("/readyz")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"


def test_readyz_ignores_unreachable_upstream_when_local_database_is_ready():
    app = create_app(
        _settings().model_copy(update={
            "db_url": "postgresql://app_rw@readyz.test/operation",
            "admin_db_url": "postgresql://admin@readyz.test/operation",
            "manager_url": "http://offline-manager.test",
            "operator_url": "http://offline-operator.test",
        }),
        _empty_router(),
    )
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = ("enterprise_account",)
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        response = TestClient(app).get("/readyz")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    connect.assert_called_once()


def test_metrics_are_privacy_safe_and_use_low_cardinality_route_labels(caplog):
    caplog.set_level(logging.INFO)
    app = create_app(_settings().model_copy(update={"log_level": "INFO"}), _empty_router())
    secret = "conversation-secret-value"
    client = TestClient(app)

    response = client.get(
        f"/api/operation/conversations/{secret}",
        params={"query": secret},
        headers={
            "X-Request-ID": "req_" + "a" * 32,
            "traceparent": "00-" + "b" * 32 + "-" + "c" * 16 + "-01",
            "X-Trace-ID": "synthetic-secret",
        },
    )
    assert response.status_code == 404

    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    assert metrics.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "aiteam_http_requests_total" in metrics.text
    assert 'route="/api/*"' in metrics.text
    assert secret not in metrics.text
    assert "query" not in metrics.text
    request_logs = [record for record in caplog.records if record.name == "shared.observability"]
    assert any(record.request_id == "req_" + "a" * 32 and record.trace_id == "b" * 32 for record in request_logs)
    assert "synthetic-secret" not in metrics.text
    assert "synthetic-secret" not in caplog.text
    assert secret not in caplog.text


def test_request_context_headers_and_structured_diagnostics(caplog):
    caplog.set_level(logging.INFO)
    app = create_app(_settings().model_copy(update={"log_level": "INFO"}), _empty_router())
    response = TestClient(app).get(
        "/healthz",
        headers={
            "X-Request-ID": "req_" + "d" * 32,
            "traceparent": "00-" + "e" * 32 + "-" + "f" * 16 + "-01",
            "X-Trace-ID": "arbitrary-legacy-value",
        },
    )
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "req_" + "d" * 32
    assert response.headers["X-Trace-ID"] == "e" * 32
    assert response.headers["traceparent"].startswith("00-" + "e" * 32 + "-")
    assert "arbitrary-legacy-value" not in response.text
    diagnostic = next(record for record in caplog.records if record.name == "shared.observability")
    assert diagnostic.request_id == "req_" + "d" * 32
    assert diagnostic.trace_id == "e" * 32
    assert diagnostic.service == "test-operation"
    assert diagnostic.http_method == "GET"
    assert diagnostic.http_route == "/healthz"
    assert diagnostic.status_code == 200
    assert diagnostic.getMessage() == "request completed"


def test_manager_readyz_fails_when_admin_database_is_unavailable():
    app = create_app(
        _settings(tier="manager").model_copy(update={
            "db_url": "postgresql://app_rw@business.test/manager",
            "admin_db_url": "postgresql://admin@admin.test/manager",
        }),
        _empty_router(prefix="/api/manager"),
    )
    business_conn = MagicMock()
    business_conn.execute.return_value.fetchone.return_value = ("tenant_registry",)
    business_context = MagicMock()
    business_context.__enter__.return_value = business_conn

    def connect(dsn, **kwargs):
        if dsn.startswith("postgresql://admin@"):
            raise OSError("admin password must not reach the response")
        return business_context

    with patch("psycopg.connect", side_effect=connect) as connect_mock:
        response = TestClient(app).get("/readyz")

    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"
    assert "admin password" not in response.text
    assert [call.args[0] for call in connect_mock.call_args_list] == [
        "postgresql://app_rw@business.test/manager",
        "postgresql://admin@admin.test/manager",
    ]


def test_production_readiness_requires_direct_app_rw_session_identity():
    app = create_app(
        _settings(tier="manager", docs=False).model_copy(update={
            "aiteam_env": "production",
            "db_url": "postgresql://app_rw@readyz.test/manager",
            "admin_db_url": "postgresql://admin@readyz.test/manager",
        }),
        _empty_router(prefix="/api/manager"),
    )
    conn = MagicMock()
    role_cursor = MagicMock()
    role_cursor.fetchone.return_value = ("app_rw", "postgres", False, False)
    schema_cursor = MagicMock()
    schema_cursor.fetchone.return_value = ("tenant_registry",)
    conn.execute.side_effect = [role_cursor, schema_cursor]
    with patch("psycopg.connect") as connect:
        connect.return_value.__enter__.return_value = conn
        response = TestClient(app).get("/readyz")
    assert response.status_code == 503
    assert response.json()["code"] == "service_unavailable"
    assert "app_rw" in response.json()["detail"]


def test_metrics_bucket_arbitrary_http_methods():
    metrics = RequestMetrics()
    for method in ("GET", "X-CUSTOM-1", "X-CUSTOM-2", "trace-secret-method"):
        metrics.record(
            service_name="test-operation",
            method=method,
            route="/api/*",
            status_code=200,
            duration_seconds=0.001,
        )
    body = metrics.render()
    assert 'method="GET"' in body
    request_counter_lines = [line for line in body.splitlines() if line.startswith("aiteam_http_requests_total{")]
    assert len([line for line in request_counter_lines if 'method="OTHER"' in line]) == 1
    assert "X-CUSTOM-1" not in body
    assert "trace-secret-method" not in body


def test_malformed_trace_context_is_replaced_with_safe_generated_context(caplog):
    caplog.set_level(logging.INFO)
    app = create_app(_settings().model_copy(update={"log_level": "INFO"}), _empty_router())
    response = TestClient(app).get(
        "/healthz",
        headers={
            "X-Request-ID": "caller-request-secret",
            "traceparent": "malformed-trace-secret",
            "X-Trace-ID": "caller-trace-secret",
        },
    )
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] != "caller-request-secret"
    assert response.headers["X-Trace-ID"] != "caller-trace-secret"
    assert response.headers["traceparent"] != "malformed-trace-secret"
    assert len(response.headers["X-Trace-ID"]) == 32
    assert response.headers["traceparent"].startswith("00-")
    assert "caller-request-secret" not in caplog.text
    assert "caller-trace-secret" not in caplog.text
    assert "malformed-trace-secret" not in caplog.text


@pytest.mark.parametrize("compatibility_value", ["0" * 32, "trace_" + "1" * 32])
def test_zero_or_legacy_trace_ids_are_replaced(compatibility_value):
    app = create_app(_settings(), _empty_router())
    response = TestClient(app).get(
        "/healthz",
        headers={"X-Trace-ID": compatibility_value},
    )
    assert response.status_code == 200
    assert response.headers["X-Trace-ID"] != compatibility_value
    assert response.headers["traceparent"].split("-")[1] == response.headers["X-Trace-ID"]
    assert response.headers["X-Trace-ID"] != "0" * 32


def test_safe_trace_headers_are_available_for_downstream_propagation():
    router = APIRouter(prefix="/api/operation")

    @router.get("/propagation")
    def propagation():
        return get_propagation_headers()

    app = create_app(_settings(), router)
    trace_id = "1" * 32
    response = TestClient(app).get(
        "/api/operation/propagation",
        headers={
            "X-Request-ID": "req_" + "2" * 32,
            "traceparent": f"00-{trace_id}-{'3' * 16}-01",
        },
    )
    assert response.status_code == 200
    headers = response.json()
    assert headers["X-Request-ID"] == "req_" + "2" * 32
    assert headers["X-Trace-ID"] == trace_id
    assert headers["traceparent"].startswith(f"00-{trace_id}-")
    assert len(headers["traceparent"].split("-")[2]) == 16


def test_formatter_redacts_relative_queries_bodies_and_credentials():
    record = logging.LogRecord(
        "test.logger",
        logging.WARNING,
        __file__,
        1,
        "/chat?access_token=query-secret body={\n"
        "  \"prompt\": \"body-secret\",\n"
        "  \"items\": [\"list-secret\", {\"nested\": \"nested-secret\"}]\n"
        "} list=[\n  \"list-body-secret\"\n] "
        "Authorization: Bearer auth-secret bEaReR standalone-bearer-secret "
        "password=password-secret token=token-secret",
        (),
        None,
    )
    formatted = _ContextFormatter().format(record)
    for secret in (
        "query-secret",
        "body-secret",
        "list-secret",
        "nested-secret",
        "list-body-secret",
        "auth-secret",
        "standalone-bearer-secret",
        "password-secret",
        "token-secret",
    ):
        assert secret not in formatted
    assert "<redacted>" in formatted or "<payload redacted>" in formatted

    exception_record = logging.LogRecord(
        "test.logger",
        logging.WARNING,
        __file__,
        1,
        "failed %s",
        (ValueError("interpolated-base-exception-secret"),),
        None,
    )
    exception_formatted = _ContextFormatter().format(exception_record)
    assert "interpolated-base-exception-secret" not in exception_formatted
    assert "<exception redacted>" in exception_formatted

    direct_exception_record = logging.LogRecord(
        "test.logger",
        logging.WARNING,
        __file__,
        1,
        ValueError("direct-log-record-secret"),
        (),
        None,
    )
    direct_exception_formatted = _ContextFormatter().format(direct_exception_record)
    assert "direct-log-record-secret" not in direct_exception_formatted
    assert "<exception redacted>" in direct_exception_formatted

    plain_body_record = logging.LogRecord(
        "test.logger",
        logging.WARNING,
        __file__,
        1,
        "payload=plain first line\nplain-body-secret second line",
        (),
        None,
    )
    plain_body_formatted = _ContextFormatter().format(plain_body_record)
    assert "plain-body-secret" not in plain_body_formatted


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
    """有 dist 产物时 mount_frontend 挂载静态资源 + SPA 回退。

    不比对固定占位文本：dist 可能是 fixture 造的 stub，也可能是本机真实构建产物。
    口径 = 回退内容与 dist/index.html 逐字节一致 + assets 下实际文件可达（环境无关）。
    """
    assert _DIST.exists()
    index_html = (_DIST / "index.html").read_text(encoding="utf-8")
    app = create_app(_settings(), _empty_router())
    mount_frontend(app, "operation")
    client = TestClient(app)

    # 根路径 -> index.html
    r = client.get("/")
    assert r.status_code == 200
    assert r.text == index_html

    # 任意前端路由 -> SPA 回退 index.html
    r2 = client.get("/some/frontend/route")
    assert r2.status_code == 200
    assert r2.text == index_html

    # 静态资源：取 dist/assets 下实际存在的文件
    asset = next(p for p in (_DIST / "assets").iterdir() if p.is_file())
    r3 = client.get(f"/assets/{asset.name}")
    assert r3.status_code == 200

    # API / 健康端点仍走具体路由，不被 SPA 回退吞掉
    assert client.get("/healthz").json()["status"] == "ok"


def test_mount_frontend_does_not_fallback_for_unknown_api_paths(_dist_dir):
    """未知 API 路径必须返回 problem+json 404，不能被 SPA 回退吞成 index.html。"""
    app = create_app(_settings(), _empty_router())
    mount_frontend(app, "operation")
    client = TestClient(app)

    secret_path = "credential-marker-do-not-echo"
    response = client.get(f"/api/operation/catalog/{secret_path}")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "text/html" not in response.headers["content-type"]
    assert response.json()["code"] == "not_found"
    assert response.json()["detail"] == "route not found"
    assert response.json()["instance"] == "/__not_found__"
    assert secret_path not in response.text
    assert "SPA" not in response.text


def test_mount_frontend_reserves_api_and_metrics_namespaces(_dist_dir):
    app = create_app(_settings(), _empty_router())
    mount_frontend(app, "operation")
    client = TestClient(app)

    for path in ("/api", "/api/credential-marker", "/metrics/credential-marker"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/problem+json")
        assert response.json()["detail"] == "route not found"
        assert response.json()["instance"] == "/__not_found__"
        assert "credential-marker" not in response.text


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
