"""按 tenant 持签名私钥（D23，03 §9.5）。

Manager 作为企业身份源，按 tenant 持 RSA 私钥签发 token；用户端只领 JWKS（公钥）验签。
私钥存控制面表 tenant_signing_key（不经 RLS 业务连接，app_rw 无权访问），绝不下发用户端。

M0：首次需要时为 tenant 生成密钥并落库（lazy provision）。key rotation 留详设。
"""

from __future__ import annotations

import psycopg

from shared.auth import RS256TokenSigner, RS256TokenVerifier, generate_rsa_keypair


class TenantKeyStore:
    """控制面密钥库。**必须用管理连接（admin DSN：超管/DDL owner）直读直写**，不经租户 RLS 会话。

    tenant_signing_key 对 app_rw 零授权（#60）；若误传业务连接（app_rw DSN），将无权读写私钥。
    """

    def __init__(self, dsn: str):
        # dsn 必须是管理连接（admin DSN）；业务连接（app_rw）对 tenant_signing_key 无授权。
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

    def public_pem_for_kid(self, kid: str) -> str | None:
        """按 kid 解析 tenant_id 并取公钥（验签专用，缺口1/D23）。

        kid 形如 "{tenant_id}:1"。验签时只有 token header 的 kid，需据此反查公钥。
        **不调 ensure()**（验签只读，不应产生建密钥副作用）；kid 无 ":"/无记录返回 None。
        """
        if ":" not in kid:
            return None
        tenant_id = kid.split(":", 1)[0]
        row = self._row(tenant_id)
        return row[2] if row else None  # row = (kid, private_pem, public_pem)
