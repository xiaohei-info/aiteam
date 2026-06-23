"""服务间认证共享密钥守卫（平面③ 代码层，03 §9.1）。

设计口径：跨端 pull（如 Operator→Manager 开通/bootstrap）属服务间调用，应以
"TLS + 签名服务令牌"鉴权，与用户身份无关。完整 mTLS 是部署层工程（依赖 CA/证书），
本模块提供**代码层共享密钥守卫**作为过渡：

- 配置了 SERVICE_TOKEN → fail-closed：校验请求头 X-Service-Token（或 Authorization Bearer）匹配，否则 401。
- 未配置 + dev 模式 → fail-open（dev 友好，启动时日志警告）。
- 未配置 + 生产模式 → fail-closed：拒绝所有服务间调用，返回 401。

生产模式判定：SERVICE_TOKEN 为占位值（dev-service-token-placeholder）或以 dev- 开头视为 dev；
否则视为生产。被调端在敏感收端（如 Manager 的 tenant/bootstrap 接收路由）挂 Depends(verify_service_token)。
"""

from __future__ import annotations

import logging

from fastapi import Request

from shared.errors import Unauthorized

logger = logging.getLogger(__name__)


def _extract_service_token(request: Request) -> str | None:
    """取请求里的服务令牌：优先 X-Service-Token，其次 Authorization: Bearer。"""
    direct = request.headers.get("X-Service-Token")
    if direct:
        return direct.strip()
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):].strip()
    return None


def _is_dev_mode(token: str | None) -> bool:
    """判断是否为 dev 模式：SERVICE_TOKEN 未配置或为 dev 占位值。"""
    if not token:
        return True
    # dev- 开头或等于 dev 占位值视为 dev 模式
    return token.startswith("dev-") or token == "dev-service-token-placeholder"


def verify_service_token(request: Request) -> None:
    """FastAPI 依赖：校验服务令牌。

    读 request.app.state.settings.service_token（被调端经 create_app 挂载的 settings）：
    - expected 为空或为 dev 占位值 → dev 模式 fail-open（日志警告，不阻断）。
    - expected 非空且非 dev 占位值 → 生产模式 fail-closed：请求 token 必须匹配，否则 401。
    - expected 为空且非 dev 模式 → 生产模式未配置，fail-closed 返回 401。
    """
    settings = getattr(request.app.state, "settings", None)
    expected = getattr(settings, "service_token", None) if settings else None

    # 判断是否为 dev 模式
    is_dev = _is_dev_mode(expected)

    if not expected:
        if is_dev:
            # dev 模式未配置：fail-open，仅日志警告
            logger.warning(
                "SERVICE_TOKEN 未配置，服务间调用无身份校验（dev 模式）。"
                "生产环境必须配置强密钥（见 deploy/SERVICE_TOKEN.md）"
            )
            return
        # 生产模式未配置：fail-closed
        raise Unauthorized(
            "SERVICE_TOKEN not configured in production mode. "
            "Service-to-service authentication required."
        )

    if is_dev:
        # dev 占位值模式：fail-open，仅日志提醒
        logger.warning(
            f"SERVICE_TOKEN 使用 dev 占位值（{expected}），服务间调用无真实校验。"
            "生产环境必须替换为强密钥（见 deploy/SERVICE_TOKEN.md）"
        )
        # dev 模式下仍然校验 token 是否匹配（允许测试 token 校验逻辑）
        provided = _extract_service_token(request)
        if provided and provided != expected:
            raise Unauthorized("invalid service token")
        return

    # 生产模式：严格校验
    provided = _extract_service_token(request)
    if not provided or provided != expected:
        raise Unauthorized("invalid service token")
