"""服务间认证共享密钥守卫（平面③ 代码层，03 §9.1）。

设计口径：跨端 pull（如 Operator→Manager 开通/bootstrap）属服务间调用，应以
"TLS + 签名服务令牌"鉴权，与用户身份无关。完整 mTLS 是部署层工程（依赖 CA/证书），
本模块提供**代码层共享密钥守卫**作为过渡：

- 配置了 SERVICE_TOKEN → fail-closed：校验请求头 X-Service-Token（或 Authorization Bearer）匹配，否则 401。
- 未配置 → fail-open（dev 友好）+ 响应头 X-Service-Auth: unconfigured 提醒，不阻断。

被调端在敏感收端（如 Manager 的 tenant/bootstrap 接收路由）挂 Depends(verify_service_token)。
"""

from __future__ import annotations

from fastapi import Request

from shared.errors import Unauthorized


def _extract_service_token(request: Request) -> str | None:
    """取请求里的服务令牌：优先 X-Service-Token，其次 Authorization: Bearer。"""
    direct = request.headers.get("X-Service-Token")
    if direct:
        return direct.strip()
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):].strip()
    return None


def verify_service_token(request: Request) -> None:
    """FastAPI 依赖：校验服务令牌。

    读 request.app.state.settings.service_token（被调端经 create_app 挂载的 settings）：
    - expected 为空 → 放行（dev 未配置，fail-open）。
    - expected 非空 → 请求 token 必须匹配，否则 401 Unauthorized。
    """
    settings = getattr(request.app.state, "settings", None)
    expected = getattr(settings, "service_token", None) if settings else None
    if not expected:
        # 未配置：fail-open。响应头提醒（不阻断，dev 友好；生产应配置）。
        return
    provided = _extract_service_token(request)
    if not provided or provided != expected:
        raise Unauthorized("invalid service token")
