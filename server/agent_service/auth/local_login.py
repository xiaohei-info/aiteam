"""用户端本地登录服务（A0 / 03 §9.4C、§9.5/§9.6/§9.8）。

口径（设计文档 §9.4C 流程图）：
    成员输入 手机号 + 初始密码
      → Agent 访问 Manager 校验凭据（首次必须在线）
      → Manager 校验通过 → issue_token + 下发验签公钥/参数
      → 用户端缓存 token，此后本地验签；token 过期需重新联网登录

职责边界（§9.8）：
- 验凭据 + 签发 token 在 Manager（凭据持有端）；用户端绝不实现 TokenSigner（D23）。
- 用户端只做：发起登录、缓存 token + 验签材料、本地无状态验签（shared/auth）。
- Manager 离线时，已登录用户凭缓存 token 继续工作（§9.8 跨端可用性）。
"""

from __future__ import annotations

import time
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, Field

from shared.auth import RS256TokenVerifier
from shared.contracts.auth import TokenClaims
from shared.errors import AppError

from .token_cache import TokenCache


class ManagerUnreachable(AppError):
    """跨端 Manager 不可达（网络/离线）。区别于凭据错误（401）。"""

    status, code, title = 503, "manager_unreachable", "Manager Unreachable"


class LoginRequest(BaseModel):
    """本地登录入参（公开端点，§9.6）。account=手机号/用户名。"""

    model_config = ConfigDict(extra="forbid")

    account: str = Field(description="手机号或用户名（按 Manager authenticator 解析）")
    password: str = Field(description="密码/初始密码；明文仅在 TLS 内传至 Manager，不落用户端日志")
    tenant_hint: str | None = Field(default=None, description="企业定位提示（可选）")


class ManagerLoginClient(Protocol):
    """跨端 Manager 登录端的窄客户端协议（A0：对端用 fake/mock）。

    实现负责经 service_client 调 Manager 校验凭据，返回 (token, jwks)。
    jwks 即 Manager `/api/auth/{tenant_id}/jwks.json` 下发的验签公钥（D23）。
    校验失败应抛 Unauthorized；不可达应抛 ManagerUnreachable。
    """

    def login(self, req: LoginRequest) -> tuple[str, dict]:
        ...


class LocalSession(BaseModel):
    """一次成功登录后的本地会话态：token + 解出的身份。"""

    model_config = ConfigDict(extra="forbid")

    token: str
    claims: TokenClaims


class LoginResult(BaseModel):
    """登录端点返回体（envelope.data）。"""

    model_config = ConfigDict(extra="forbid")

    token: str
    claims: TokenClaims


def _now() -> int:
    return int(time.time())


class LocalLoginService:
    """编排本地登录三段：在线取 token → 缓存 → 本地验签复用 / 离线降级。

    本地验签用 RS256TokenVerifier.from_jwks(jwks)（D23，03 §9.5）：
    Manager 私钥签发，Agent 只持公钥/JWKS 本地无状态验签。
    """

    def __init__(self, *, manager: ManagerLoginClient, cache: TokenCache):
        self._manager = manager
        self._cache = cache

    # --- 首次在线 ---
    def login(self, req: LoginRequest) -> LocalSession:
        """首次/重新登录：联网经 Manager 校验，缓存 token + JWKS，返回本地会话。"""
        token, jwks = self._manager.login(req)
        claims = self._verify(token, jwks)
        if claims is None:
            # Manager 返回的 token 本地验不过 = JWKS 与签发私钥不匹配，属契约异常，不静默吞。
            raise ManagerUnreachable("token from manager failed local verification")
        self._cache.store(token, jwks)
        return LocalSession(token=token, claims=claims)

    # --- 本地验签复用 / 离线降级 ---
    def current_identity(self) -> TokenClaims | None:
        """从缓存做本地无状态验签，得到当前身份；无缓存/已过期/验签失败返回 None。

        **不访问 Manager**——这正是"首次在线、之后本地"与离线降级的落点。
        """
        entry = self._cache.load()
        if entry is None:
            return None
        return self._verify(entry.token, entry.verify_material)

    def current_token(self) -> str | None:
        """返回当前缓存的用户 token（未登录 → None）。供下游 Manager 目录拉取使用。"""
        entry = self._cache.load()
        return entry.token if entry is not None else None

    def logout(self) -> None:
        self._cache.clear()

    # --- 本地无状态验签（含过期检查） ---
    @staticmethod
    def _verify(token: str, jwks: dict) -> TokenClaims | None:
        verifier = RS256TokenVerifier.from_jwks(jwks)
        try:
            claims = verifier.verify(token)
        except AppError:
            return None
        if claims.exp <= _now():
            return None  # 过期需重新联网登录（§9.5）
        return claims
