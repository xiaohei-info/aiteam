"""运营端认证面北向路由（/api/operation/auth/*，§9.4 系统账号登录）。

公开端点（无 token）：POST /api/operation/auth/login。
verifier 由 app 持有并挂 app.state._operation_auth（懒构造 + 缓存，与 manager routes_auth 一致）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from shared.contracts.envelope import Envelope
from shared.errors import Unauthorized

from .auth_service import OperationAuthService, SystemAuthResult, SystemLoginInput

router = APIRouter(prefix="/api/operation/auth", tags=["operation", "auth"])


def _service(request: Request) -> OperationAuthService:
    """从 app.state 取 OperationAuthService（app 启动时构造挂载）。"""
    svc = getattr(request.app.state, "_operation_auth", None)
    if svc is None:
        # app 未挂载 _operation_auth → 503（不静默，与各端"未配置"口径一致）。
        from shared.errors import AppError

        raise AppError(
            status=503, code="operation_auth_unconfigured",
            title="Operation Auth Unconfigured",
            detail="OperationAuthService 未挂载 app.state._operation_auth",
        )
    return svc


@router.post("/login", description="系统管理员用账号密码登录运营端。返回 JWT token。", summary="系统账号登录（公开端点）", operation_id="operation_system_login")
async def login(body: SystemLoginInput, request: Request) -> Response:
    from fastapi.responses import JSONResponse

    if request.headers.get("X-Service-Token") is not None:
        raise Unauthorized("service token is not accepted on auth endpoints")

    result: SystemAuthResult = _service(request).login(body)
    envelope = Envelope[SystemAuthResult].model_validate({"data": result})
    return JSONResponse(status_code=200, content=envelope.model_dump(mode="json"))
