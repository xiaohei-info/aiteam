"""服务间共享密钥守卫验收（缺口3 代码层，平面③）。

fail-open（未配置 SERVICE_TOKEN 放行）+ fail-closed（配置后校验 X-Service-Token）。
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


def test_fail_open_when_unconfigured():
    client = TestClient(_app(service_token=None))
    r = client.post("/protected")  # 无 token header
    assert r.status_code == 200


def test_fail_closed_requires_token_when_configured():
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected")  # 无 token
    assert r.status_code == 401


def test_fail_closed_rejects_wrong_token():
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"X-Service-Token": "wrong"})
    assert r.status_code == 401


def test_accepts_matching_x_service_token():
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"X-Service-Token": "s3cret"})
    assert r.status_code == 200


def test_accepts_matching_bearer_authorization():
    client = TestClient(_app(service_token="s3cret"))
    r = client.post("/protected", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200
