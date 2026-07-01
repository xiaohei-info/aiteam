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


def _load_or_create_db_signing_key(admin_db_url: str, kid: str) -> str:
    """从 operation_signing_key 表加载 kid 对应私钥；无则生成并落库，返回私钥 PEM。

    幂等且多实例竞争安全：INSERT ... ON CONFLICT DO NOTHING 后再 SELECT，取到最终落库者，
    使并发启动的多个实例最终用同一把 key。表由迁移 0002 建（调用方须先跑迁移）。
    """
    import psycopg

    with psycopg.connect(admin_db_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT private_pem FROM operation_signing_key WHERE kid = %s", (kid,)
        ).fetchone()
        if row:
            return row[0]
        priv_pem, pub_pem = generate_rsa_keypair()
        conn.execute(
            "INSERT INTO operation_signing_key (kid, private_pem, public_pem) "
            "VALUES (%s, %s, %s) ON CONFLICT (kid) DO NOTHING",
            (kid, priv_pem, pub_pem),
        )
        row = conn.execute(
            "SELECT private_pem FROM operation_signing_key WHERE kid = %s", (kid,)
        ).fetchone()
        return row[0]


def build_operation_auth_service(admin_db_url: str | None = None) -> OperationAuthService:
    """构造 OperationAuthService：装配签名 key + seed 默认 system_admin。

    签名密钥来源优先级：
    1. env OPERATION_SIGNING_PRIVATE_KEY/PUBLIC_KEY 显式配置 → 用它（外部密钥管理/固定轮换）。
    2. admin_db_url 可用 → operation_signing_key 表持久化：有则加载、无则生成并固定
       （任何环境自动生成，跨重启/多实例稳定，操作员 token 不再因重启失效）。
    3. 无 DB（骨架/纯契约/单元测试）→ 启动临时生成（行为同旧默认）。
    """
    priv_pem = os.getenv("OPERATION_SIGNING_PRIVATE_KEY")
    pub_pem = os.getenv("OPERATION_SIGNING_PUBLIC_KEY")
    if priv_pem and pub_pem:
        signer = RS256TokenSigner(priv_pem, kid=KID)
    elif admin_db_url:
        signer = RS256TokenSigner(_load_or_create_db_signing_key(admin_db_url, KID), kid=KID)
    else:
        priv_pem, _ = generate_rsa_keypair()
        signer = RS256TokenSigner(priv_pem, kid=KID)
    repo = build_system_account_repository()
    return OperationAuthService(repo=repo, signer=signer, kid=KID)
