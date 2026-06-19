"""用户端本地认证（A0 / 03 §9.4C）。

本地登录三段口径：首次在线取 token（经 Manager 校验凭据）→ 本地缓存 token + 验签材料
→ 此后本地无状态验签复用、Manager 离线可降级继续工作。

红线：用户端只持验签材料（公钥/JWKS），绝不持可签发 token 的密钥（03 §9.5/D23）。
"""

from .local_login import (
    LocalLoginService,
    LocalSession,
    LoginRequest,
    LoginResult,
    ManagerLoginClient,
    ManagerUnreachable,
)
from .token_cache import InMemoryTokenCache, TokenCache, CachedToken

__all__ = [
    "LocalLoginService",
    "LocalSession",
    "LoginRequest",
    "LoginResult",
    "ManagerLoginClient",
    "ManagerUnreachable",
    "TokenCache",
    "InMemoryTokenCache",
    "CachedToken",
]
