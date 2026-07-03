"""服务间共享密钥守卫验收（缺口3 代码层，平面③）。

fail-closed（未配置 / 误配 dev-* 前缀 / 占位值各自对应不同行为）：未配置 SERVICE_TOKEN → fail-closed 401；
dev-* 前缀视为生产 token 严格校验（AITEAM-331 B2）；仅占位值 `dev-service-token-placeholder` 在明确 dev
profile 下 fail-open（日志提醒）；其他非空 token → fail-closed 严格校验 X-Service-Token。
"""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.errors import install_exception_handlers
from shared.service_token import verify_service_token


def _app(service_token: str | None) -> FastAPI:
    app = FastAPI()
    install_exception_handlers(app)  # 装 AppError → problem+json 处理器，Unauthorized → 401
    app.state.settings = Settings(tier="manager", service_name="mgr-test", service_token=service_token)

    @app.post("/protected")
    def protected(_=Depends(verify_service_token)):
        return {"ok": True}

    return app


# ========== Dev 模式测试（fail-open）==========


def test_fail_closed_when_unconfigured():
    """AITEAM-331 B2：未配置 SERVICE_TOKEN → fail-closed 401。"""
    client = TestClient(_app(service_token=None))
    r = client.post("/protected")  # 无 token header
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")


def test_fail_open_with_dev_placeholder():
    """dev 占位值（dev-service-token-placeholder）：fail-open 放行。"""
    client = TestClient(_app(service_token="dev-service-token-placeholder"))
    r = client.post("/protected")  # 无 token header
    assert r.status_code == 200


def test_dev_mode_accepts_matching_token():
    """dev 模式带正确 token：放行（可测试 token 校验逻辑）。"""
    client = TestClient(_app(service_token="dev-service-token-placeholder"))
    r = client.post("/protected", headers={"X-Service-Token": "dev-service-token-placeholder"})
    assert r.status_code == 200


def test_dev_mode_rejects_wrong_token():
    """dev 模式带错误 token：拒绝（即使 dev 模式也校验 token 匹配）。"""
    client = TestClient(_app(service_token="dev-service-token-placeholder"))
    r = client.post("/protected", headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401


def test_dev_prefix_token_is_strict_production():
    """AITEAM-331 B2：dev-* 前缀不再视为 dev 模式 → fail-closed，必须携带匹配 token。"""
    client = TestClient(_app(service_token="dev-abc-not-dev-mode"))
    # 无 token header → 401（dev-* 前缀不再是 fail-open）
    r = client.post("/protected")
    assert r.status_code == 401

def test_dev_prefix_accepted_with_matching_token():
    """AITEAM-331 B2：dev-* 前缀 token 按生产模式严格校验，匹配即放行。"""
    client = TestClient(_app(service_token="dev-abc-not-dev-mode"))
    r = client.post("/protected", headers={"X-Service-Token": "dev-abc-not-dev-mode"})
    assert r.status_code == 200


# ========== 生产模式测试（fail-closed）==========


def test_production_mode_requires_token_when_configured():
    """生产模式配置了强密钥：无 token 时拒绝。"""
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected")  # 无 token
    assert r.status_code == 401


def test_production_mode_rejects_wrong_token():
    """生产模式配置了强密钥：错误 token 时拒绝。"""
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401


def test_production_mode_accepts_matching_x_service_token():
    """生产模式配置了强密钥：正确 X-Service-Token 时放行。"""
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"X-Service-Token": "s3cret"})
    assert r.status_code == 200


def test_production_mode_accepts_matching_bearer_authorization():
    """生产模式配置了强密钥：正确 Authorization Bearer 时放行。"""
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200


# ========== 跨端调用集成测试 ==========


def test_cross_tier_call_with_correct_token():
    """跨端调用携带正确 SERVICE_TOKEN：成功。"""
    from shared.service_client import ServiceClient
    import httpx

    # 模拟被调端（Manager）
    manager_app = _app(service_token="shared-secret-123")

    # 使用 MockTransport 将 httpx 请求路由到 TestClient
    def handler(request: httpx.Request) -> httpx.Response:
        # 通过 TestClient 调用 FastAPI app
        with TestClient(manager_app) as client:
            response = client.request(
                method=request.method,
                url=request.url.path,
                headers=dict(request.headers),
                content=request.content,
            )
            return httpx.Response(
                status_code=response.status_code,
                headers=response.headers,
                content=response.content,
            )

    transport = httpx.MockTransport(handler)
    caller = ServiceClient(
        base_url="http://manager:8000",
        service_identity="operation-service",
        service_token="shared-secret-123",
        transport=transport,
    )

    # 发起调用
    result = caller.post("/protected", json={})
    assert result == {"ok": True}


def test_cross_tier_call_with_wrong_token():
    """跨端调用携带错误 SERVICE_TOKEN：401。"""
    from shared.service_client import ServiceClient
    import httpx
    from shared.errors import Unauthorized
    import pytest

    # 模拟被调端（Manager）
    manager_app = _app(service_token="shared-secret-123")

    # 使用 MockTransport 将 httpx 请求路由到 TestClient
    def handler(request: httpx.Request) -> httpx.Response:
        with TestClient(manager_app) as client:
            response = client.request(
                method=request.method,
                url=request.url.path,
                headers=dict(request.headers),
                content=request.content,
            )
            return httpx.Response(
                status_code=response.status_code,
                headers=response.headers,
                content=response.content,
            )

    transport = httpx.MockTransport(handler)
    caller = ServiceClient(
        base_url="http://manager:8000",
        service_identity="operation-service",
        service_token="wrong-token",  # 错误 token
        transport=transport,
    )

    # 发起调用
    with pytest.raises(Unauthorized):
        caller.post("/protected", json={})
