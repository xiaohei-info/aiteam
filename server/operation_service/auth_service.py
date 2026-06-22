"""运营端认证服务（§9.2 系统账号→运营端本地校验）。

Operation 自持系统级 RSA 密钥（启动生成或 env 注入），自签自验系统账号 token。
与 Manager 多租户签名不同——Operation 是单实例控制面，单一系统级 key 即可。

口径（03 §9.5/D23）：RS256 非对称签名。系统账号 token 载荷 tenant_id=None（平台级）。
"""

from __future__ import annotations

import os
import time

from pydantic import BaseModel, ConfigDict

from shared.auth import RS256TokenSigner, generate_rsa_keypair
from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized
from shared.security import verify_password

from .system_repository import SystemAccount, SystemAccountRepository, build_system_account_repository

KID = "operation:1"
_ACCESS_TTL_SECONDS = 3600


class SystemLoginInput(BaseModel):
    """系统登录入参（公开端点）。"""

    model_config = ConfigDict(extra="forbid")

    username: str
    password: str


class SystemAuthResult(BaseModel):
    """系统登录返回体（envelope.data）。"""

    model_config = ConfigDict(extra="forbid")

    token: str
    claims: TokenClaims


class OperationAuthService:
    """运营端系统账号认证：本地校验凭据 + RS256 签发系统 token。"""

    def __init__(self, *, repo: SystemAccountRepository, signer: RS256TokenSigner, kid: str = KID):
        self._repo = repo
        self._signer = signer
        self.kid = kid

    @property
    def signer(self) -> RS256TokenSigner:
        """签发器（供 app 构造验签器取公钥；内部 login 用）。"""
        return self._signer

    def login(self, req: SystemLoginInput) -> SystemAuthResult:
        account = self._repo.find(req.username)
        if account is None or not verify_password(req.password, account.password_hash):
            raise Unauthorized("invalid credentials")
        return self._issue(account)

    def _issue(self, account: SystemAccount) -> SystemAuthResult:
        claims = TokenClaims(
            tenant_id=None,  # 平台级系统账号，无 tenant
            user_id=account.username,
            roles=account.roles,
            exp=int(time.time()) + _ACCESS_TTL_SECONDS,
        )
        return SystemAuthResult(token=self._signer.sign(claims), claims=claims)


def build_operation_auth_service() -> OperationAuthService:
    """构造 OperationAuthService：启动生成 RSA key（或 env 注入）+ seed 默认 system_admin。

    env（可选，生产持久化密钥）：
    - OPERATION_SIGNING_PRIVATE_KEY / OPERATION_SIGNING_PUBLIC_KEY：固定密钥对（PEM）。
      未设则启动生成（重启失效，操作员需重新登录——可接受，控制面非高可用长会话场景）。
    """
    priv_pem = os.getenv("OPERATION_SIGNING_PRIVATE_KEY")
    pub_pem = os.getenv("OPERATION_SIGNING_PUBLIC_KEY")
    if priv_pem and pub_pem:
        # 用固定密钥（持久化场景）；kid 固定，重启后旧 token 仍有效
        signer = RS256TokenSigner(priv_pem, kid=KID)
    else:
        # 启动生成（dev/默认；重启失效）
        priv_pem, _ = generate_rsa_keypair()
        signer = RS256TokenSigner(priv_pem, kid=KID)
    repo = build_system_account_repository()
    return OperationAuthService(repo=repo, signer=signer, kid=KID)
