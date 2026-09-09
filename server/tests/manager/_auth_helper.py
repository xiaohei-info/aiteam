"""Manager 测试鉴权 helper（批次D：RS256 验签落地后的测试基建）。

Manager 受保护端点用 DynamicRS256TokenVerifier（按 token kid 解析 tenant_id → TenantKeyStore
查公钥）。测试需要：
- make_verifier(admin_url)：构造绑定本测试 PG 的 DynamicRS256TokenVerifier，注入 app。
- sign_token(admin_url, tenant_id, roles)：用 TenantKeyStore.signer（admin 连接 ensure 落库）
  签真实 RS256 token，与 make_verifier 闭环。

无 DB 的非集成测试用 make_inmem_verifier_and_signer()（固定 RSA key，不依赖 PG）。
"""

from __future__ import annotations

import jwt

from shared.auth import DynamicRS256TokenVerifier, ResolvedPublicKey, RS256TokenSigner, generate_rsa_keypair
from shared.contracts.auth import TokenClaims


class _TenantTestSigner(RS256TokenSigner):
    """Test signer whose kid mirrors each claim tenant for bound-verifier tests."""

    def sign(self, claims: TokenClaims) -> str:
        return jwt.encode(
            claims.model_dump(exclude_none=True),
            self._private_pem,
            algorithm="RS256",
            headers={"kid": f"{claims.tenant_id}:test"},
        )


def make_verifier(admin_url: str) -> DynamicRS256TokenVerifier:
    """构造绑定本测试 admin_url 的动态验签器（真 PG 闭环）。"""
    from manager_service.keys import TenantKeyStore

    return DynamicRS256TokenVerifier(TenantKeyStore(admin_url).resolved_public_key_for_kid)


def sign_token(admin_url: str, tenant_id: str, roles: list[str], *, user_id: str = "u") -> str:
    """用 admin_url 经 TenantKeyStore 签 RS256 token（ensure 落库，与 make_verifier 闭环）。"""
    from manager_service.keys import TenantKeyStore

    return TenantKeyStore(admin_url).signer(tenant_id).sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id, roles=roles, exp=9999999999)
    )


def make_inmem_verifier_and_signer() -> tuple[DynamicRS256TokenVerifier, RS256TokenSigner]:
    """无 DB 测试用：固定 RSA key（不依赖 PG），返回 (verifier, signer)。

    verifier 是 DynamicRS256TokenVerifier，resolver 返回 kid 中的 tenant scope 与公钥。
    """
    priv, _ = generate_rsa_keypair()
    signer = _TenantTestSigner(priv, kid="test-manager:1")
    pub = signer.public_pem()

    def resolve(kid):
        if not isinstance(kid, str) or ":" not in kid:
            return None
        return ResolvedPublicKey(kid.split(":", 1)[0], pub)

    verifier = DynamicRS256TokenVerifier(resolve)
    return verifier, signer


def sign_inmem_token(signer: RS256TokenSigner, tenant_id: str, roles: list[str], *, user_id: str = "u") -> str:
    """无 DB 测试用：用 inmem signer 签 token。"""
    return signer.sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id, roles=roles, exp=9999999999)
    )
