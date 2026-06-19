"""认证底座（03 §9，D8/D23）。

职责拆分（03 §9.8）：
- 验签 + 解身份：纯计算，共享库（本模块），各端 import，不是网络服务、不回调。
- 鉴权②：纯逻辑 helper（authorize），策略留各端。
- 签发 token：纯计算 helper，仅凭据持有端校验通过后调用。

生产口径（D23）：**非对称签名**——Manager 按 tenant 持私钥签发，Agent 只持公钥/JWKS 验签；
禁止向用户端下发 HMAC 对称签名密钥。真实 RSA/JWKS + key rotation 留详设（03 §9.5）。

本骨架提供：TokenSigner/TokenVerifier 抽象 + 仅供测试的 DevTokenService + FastAPI 依赖
（解出 TokenClaims / 构造 TenantContext / authorize 角色校验）。
"""

from __future__ import annotations

import base64
import hashlib
import json
from abc import ABC, abstractmethod

from fastapi import Depends, Request

from shared.contracts.auth import TokenClaims
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, Unauthorized


class TokenVerifier(ABC):
    """本地无状态验签（03 §9.5）。生产实现用公钥/JWKS。"""

    @abstractmethod
    def verify(self, token: str) -> TokenClaims:
        ...


class TokenSigner(ABC):
    """token 签发（03 §9.5）。仅凭据持有端持私钥实现；用户端不实现。"""

    @abstractmethod
    def sign(self, claims: TokenClaims) -> str:
        ...


class DevTokenService(TokenSigner, TokenVerifier):
    """⚠️ 仅供 dev/测试，**非生产**。

    用 base64(json) + sha256(secret+payload) 做最简自包含 token，验证一致性即可。
    生产**必须**替换为非对称签名实现（Manager 私钥签发 / Agent 公钥验签，D23），
    禁止把本类或任何对称密钥下发到用户端。
    """

    def __init__(self, secret: str = "dev-only-not-for-production"):
        self._secret = secret

    def _sig(self, payload_b64: str) -> str:
        return hashlib.sha256((self._secret + payload_b64).encode()).hexdigest()

    def sign(self, claims: TokenClaims) -> str:
        payload = base64.urlsafe_b64encode(claims.model_dump_json().encode()).decode()
        return f"{payload}.{self._sig(payload)}"

    def verify(self, token: str) -> TokenClaims:
        try:
            payload, sig = token.split(".", 1)
        except ValueError as exc:
            raise Unauthorized("malformed token") from exc
        if self._sig(payload) != sig:
            raise Unauthorized("bad signature")
        try:
            data = json.loads(base64.urlsafe_b64decode(payload.encode()))
        except Exception as exc:  # noqa: BLE001
            raise Unauthorized("undecodable token") from exc
        return TokenClaims(**data)


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise Unauthorized("missing bearer token")
    return header[len("Bearer "):].strip()


def require_claims(verifier: TokenVerifier):
    """FastAPI 依赖工厂：受保护端点用 Depends(require_claims(verifier)) 解出 TokenClaims。

    无 token / 验签失败 / 过期 → 401（公开端点不挂此依赖即放行，03 §9.6）。
    """

    def _dep(request: Request) -> TokenClaims:
        return verifier.verify(_bearer_token(request))

    return _dep


def tenant_context_from(claims: TokenClaims) -> TenantContext:
    """由 claims 构造 TenantContext（Manager 内 tenant_id 必有）。"""
    if not claims.tenant_id:
        raise Forbidden("token missing tenant scope")
    return TenantContext(
        tenant_id=claims.tenant_id,
        user_id=claims.user_id,
        roles=claims.roles,
        enterprise_id=claims.enterprise_id,
    )


def authorize(claims: TokenClaims, allowed_roles: list[str]) -> None:
    """鉴权②角色校验（03 §9.7）。越权 → 403。资源归属/成员级授权由各端业务自行追加校验。"""
    if not set(claims.roles) & set(allowed_roles):
        raise Forbidden(f"requires one of roles: {allowed_roles}")
