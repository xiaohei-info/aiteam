"""按 tenant 持签名私钥（D23，03 §9.5）。

Manager 作为企业身份源，按 tenant 持 RSA 私钥签发 token；用户端只领 JWKS（公钥）验签。
私钥存控制面表 tenant_signing_key（不经 RLS 业务连接，app_rw 无权访问），绝不下发用户端。

M0：首次需要时为 tenant 生成密钥并落库（lazy provision）。key rotation 留详设。
"""

from __future__ import annotations

import psycopg

from shared.auth import RS256TokenSigner, RS256TokenVerifier, generate_rsa_keypair


class TenantKeyStore:
    """控制面密钥库。用连接身份（管理连接）直读直写，不经租户 RLS 会话。"""

    def __init__(self, dsn: str):
        self._dsn = dsn

    def _row(self, tenant_id: str):
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return conn.execute(
                "SELECT kid, private_pem, public_pem FROM tenant_signing_key WHERE tenant_id = %s",
                (tenant_id,),
            ).fetchone()

    def ensure(self, tenant_id: str) -> None:
        """确保 tenant 有签名密钥；无则生成并落库（幂等）。"""
        if self._row(tenant_id):
            return
        private_pem, public_pem = generate_rsa_keypair()
        kid = f"{tenant_id}:1"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO tenant_signing_key (tenant_id, kid, private_pem, public_pem) "
                "VALUES (%s, %s, %s, %s) ON CONFLICT (tenant_id) DO NOTHING",
                (tenant_id, kid, private_pem, public_pem),
            )

    def signer(self, tenant_id: str) -> RS256TokenSigner:
        """取 tenant 的签发器（私钥）。仅 Manager 内部调用，结果不外泄。"""
        self.ensure(tenant_id)
        kid, private_pem, _ = self._row(tenant_id)
        return RS256TokenSigner(private_pem, kid=kid)

    def jwks(self, tenant_id: str) -> dict:
        """取 tenant 的 JWKS（公钥）。可下发用户端本地验签。"""
        self.ensure(tenant_id)
        kid, _, public_pem = self._row(tenant_id)
        from shared.auth import jwks_from_public_pem

        return jwks_from_public_pem(kid, public_pem)

    def verifier(self, tenant_id: str) -> RS256TokenVerifier:
        return RS256TokenVerifier.from_jwks(self.jwks(tenant_id))
