"""服务间认证共享密钥守卫（平面③ 代码层，03 §9.1）。

设计口径：跨端 pull（如 Operator→Manager 开通/bootstrap）属服务间调用，应以
"TLS + 签名服务令牌"鉴权，与用户身份无关。完整 mTLS 是部署层工程（依赖 CA/证书），
本模块提供**代码层共享密钥守卫**：

- 配置了非 dev 的 SERVICE_TOKEN → fail-closed：校验请求头 X-Service-Token
  （或 Authorization Bearer）匹配，否则 401。
- 未配置 SERVICE_TOKEN → **fail-closed**：拒绝所有服务间调用，返回 401
  （历史版本未配置时 fail-open，等同隐藏的后门；AITEAM-331 B2 已 fail-closed）。
- 占位值 `dev-service-token-placeholder` 仅在明确声明的 dev profile 下生效；
  `dev-*` 前缀不再视为 dev——任意非占位的真实 token 一律按生产严格校验，
  防止线上误配 `dev-*` 导致 fully-open（AITEAM-331 B2）。

生产模式判定：SERVICE_TOKEN 值为占位值 `dev-service-token-placeholder` 视为 dev；
其他非空值视为生产；空/未配置视为 fail-closed 拒绝。
"""

from __future__ import annotations

import logging

from fastapi import Request

from shared.errors import Unauthorized

logger = logging.getLogger(__name__)

# 唯一允许的 dev 占位值；其余任意 dev-* 开头 token 一律按生产严格校验（AITEAM-331 B2）。
_DEV_TOKEN_PLACEHOLDER = "dev-service-token-placeholder"


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
    """判断是否为 dev 模式：仅占位值 `dev-service-token-placeholder` 视为 dev。

    与历史实现的区别：不再以 `dev-` 前缀作为 dev 判定（任意 `dev-*` token 按生产严格校验），
    也不再视未配置为 dev（未配置现在 fail-closed，AITEAM-331 B2）。
    """
    return token == _DEV_TOKEN_PLACEHOLDER


def verify_service_token(request: Request) -> None:
    """FastAPI 依赖：校验服务令牌（AITEAM-331 B2 fail-closed）。

    读 request.app.state.settings.service_token（被调端经 create_app 挂载的 settings）：
    - expected 为空/未配置 → fail-closed：拒绝所有服务间调用，返回 401。
    - expected 为 dev 占位值 → dev profile fail-open（仅占位值；生产必须替换为强密钥）。
    - expected 非空且非 dev 占位值 → 生产模式 fail-closed：请求 token 必须匹配，否则 401。
    """
    settings = getattr(request.app.state, "settings", None)
    expected = getattr(settings, "service_token", None) if settings else None

    # dev profile：唯一允许的占位值在此处生效；任意 dev-* token 按生产严格校验。
    is_dev = _is_dev_mode(expected)

    if not expected:
        # 未配置 SERVICE_TOKEN → fail-closed（AITEAM-331 B2）。
        raise Unauthorized(
            "SERVICE_TOKEN is not configured. Service-to-service authentication is required."
        )

    if is_dev:
        # 占位值模式：fail-open，仅日志提醒（仅允许占位值；dev-* 前缀不走这条）。
        logger.warning(
            "SERVICE_TOKEN 使用 dev 占位值（dev-service-token-placeholder），服务间调用无真实校验。"
            "生产环境必须替换为强密钥（见 deploy/SERVICE_TOKEN.md）"
        )
        # dev 模式下仍然校验 token 是否匹配（允许测试 token 校验逻辑）。
        provided = _extract_service_token(request)
        if provided and provided != expected:
            raise Unauthorized("invalid service token")
        return

    # 生产模式：严格校验（任意 dev-* 前缀 token 同样严格，不做 fail-open）。
    provided = _extract_service_token(request)
    if not provided or provided != expected:
        raise Unauthorized("invalid service token")
