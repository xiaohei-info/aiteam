"""Manager 测试鉴权 helper（批次D：RS256 验签落地后的测试基建）。

Manager 受保护端点用 DynamicRS256TokenVerifier（按 token kid 解析 tenant_id → TenantKeyStore
查公钥）。测试需要：
- make_verifier(admin_url)：构造绑定本测试 PG 的 DynamicRS256TokenVerifier，注入 app。
- sign_token(admin_url, tenant_id, roles)：用 TenantKeyStore.signer（admin 连接 ensure 落库）
  签真实 RS256 token，与 make_verifier 闭环。

无 DB 的非集成测试用 make_inmem_verifier_and_signer()（固定 RSA key，不依赖 PG）。
"""

from __future__ import annotations

from shared.auth import DynamicRS256TokenVerifier, RS256TokenSigner, generate_rsa_keypair
from shared.contracts.auth import TokenClaims


def make_verifier(admin_url: str) -> DynamicRS256TokenVerifier:
    """构造绑定本测试 admin_url 的动态验签器（真 PG 闭环）。"""
    from manager_service.keys import TenantKeyStore

    return DynamicRS256TokenVerifier(TenantKeyStore(admin_url).public_pem_for_kid)


def sign_token(admin_url: str, tenant_id: str, roles: list[str], *, user_id: str = "u") -> str:
    """用 admin_url 经 TenantKeyStore 签 RS256 token（ensure 落库，与 make_verifier 闭环）。"""
    from manager_service.keys import TenantKeyStore

    return TenantKeyStore(admin_url).signer(tenant_id).sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id, roles=roles, exp=9999999999)
    )


def make_inmem_verifier_and_signer() -> tuple[DynamicRS256TokenVerifier, RS256TokenSigner]:
    """无 DB 测试用：固定 RSA key（不依赖 PG），返回 (verifier, signer)。

    verifier 是 DynamicRS256TokenVerifier，resolver 固定返回本 signer 的公钥（任意 kid）。
    """
    priv, _ = generate_rsa_keypair()
    signer = RS256TokenSigner(priv, kid="test-manager:1")
    pub = signer.public_pem()
    verifier = DynamicRS256TokenVerifier(lambda _kid: pub)
    return verifier, signer


def sign_inmem_token(signer: RS256TokenSigner, tenant_id: str, roles: list[str], *, user_id: str = "u") -> str:
    """无 DB 测试用：用 inmem signer 签 token。"""
    return signer.sign(
        TokenClaims(tenant_id=tenant_id, user_id=user_id, roles=roles, exp=9999999999)
    )
