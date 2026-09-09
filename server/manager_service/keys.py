"""按 tenant 持签名私钥（D23，03 §9.5）。

Manager 作为企业身份源，按 tenant 持 RSA 私钥签发 token；用户端只领 JWKS（公钥）验签。
私钥存控制面表 tenant_signing_key（不经 RLS 业务连接，app_rw 无权访问），绝不下发用户端。

key rotation 口径（D23，03 §9.5）：
- rotate(tenant_id)：生成新密钥对 → 旧密钥 retired_at=now() → 新密钥 is_current=true。
- signer(tenant_id)：取 is_current=true 的行签发新 token。
- jwks(tenant_id)：返回 is_current=true + 宽限期内（retired_at > now() - GRACE）的所有公钥，
  保证在用 token 平滑失效、不静默拒绝已登录会话（D23 红线：轮换期新旧公钥并存）。
- resolved_public_key_for_kid(kid)：按 kid 反查公钥并保留 registry tenant scope；旧 public_pem_for_kid 仅作兼容读取。
"""

from __future__ import annotations

from uuid import UUID

import psycopg

from shared.auth import ResolvedPublicKey, RS256TokenSigner, RS256TokenVerifier, generate_rsa_keypair, jwks_from_public_pem

# 宽限期：轮换后旧公钥保留在 JWKS 的时长（秒）。旧 token exp 通常 1h，默认 24h 覆盖所有在用会话。
ROTATION_GRACE_SECONDS = 86400


class TenantKeyStore:
    """控制面密钥库。**必须用管理连接（admin DSN：超管/DDL owner）直读直写**，不经租户 RLS 会话。

    tenant_signing_key 对 app_rw 零授权（#60）；若误传业务连接（app_rw DSN），将无权读写私钥。
    """

    def __init__(self, dsn: str):
        self._dsn = dsn

    def _current_row(self, tenant_id: str):
        """取该 tenant is_current=true 的签发密钥行。"""
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return conn.execute(
                "SELECT kid, private_pem, public_pem, version FROM tenant_signing_key"
                " WHERE tenant_id = %s AND is_current = true",
                (tenant_id,),
            ).fetchone()

    def _active_public_rows(self, tenant_id: str) -> list[tuple]:
        """取该 tenant 所有验签有效的公钥行（当前 + 宽限期内的 retired）。

        宽限期内旧公钥保留在 JWKS，保证在用 token 不被静默拒绝（D23 红线）。
        """
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return conn.execute(
                "SELECT kid, public_pem FROM tenant_signing_key"
                " WHERE tenant_id = %s"
                "   AND (is_current = true"
                "        OR (retired_at IS NOT NULL"
                "            AND retired_at > now() - interval '%s seconds'))",
                (tenant_id, ROTATION_GRACE_SECONDS),
            ).fetchall()

    def ensure(self, tenant_id: str) -> None:
        """确保 tenant 有签名密钥；无则生成并落库（幂等）。"""
        if self._current_row(tenant_id):
            return
        private_pem, public_pem = generate_rsa_keypair()
        kid = f"{tenant_id}:1"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO tenant_signing_key"
                " (tenant_id, kid, private_pem, public_pem, is_current, version)"
                " VALUES (%s, %s, %s, %s, true, 1)"
                " ON CONFLICT (kid) DO NOTHING",
                (tenant_id, kid, private_pem, public_pem),
            )

    def rotate(self, tenant_id: str) -> str:
        """轮换密钥：生成新密钥对，旧密钥 retired_at=now()，新密钥成为 is_current。

        返回新密钥的 kid。

        轮换红线（D23）：
        - 旧密钥不删除，retired_at=now() 后宽限期（ROTATION_GRACE_SECONDS）内仍在 JWKS，
          保证在用 token 平滑失效、不静默拒绝已登录会话。
        - 新密钥 is_current=true，此后所有新签发 token 使用新私钥。
        """
        self.ensure(tenant_id)
        current = self._current_row(tenant_id)
        # 版本号：从当前 kid 解析版本并 +1
        try:
            current_version = int(current[0].split(":")[-1])
        except (ValueError, IndexError):
            current_version = int(current[3]) if current[3] else 1
        new_version = current_version + 1
        new_kid = f"{tenant_id}:{new_version}"

        private_pem, public_pem = generate_rsa_keypair()
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            # 先插入新密钥
            conn.execute(
                "INSERT INTO tenant_signing_key"
                " (tenant_id, kid, private_pem, public_pem, is_current, version)"
                " VALUES (%s, %s, %s, %s, true, %s)",
                (tenant_id, new_kid, private_pem, public_pem, new_version),
            )
            # 旧密钥退役：is_current=false + retired_at=now()
            conn.execute(
                "UPDATE tenant_signing_key"
                " SET is_current = false, retired_at = now()"
                " WHERE tenant_id = %s AND kid = %s",
                (tenant_id, current[0]),
            )
        return new_kid

    def signer(self, tenant_id: str) -> RS256TokenSigner:
        """取 tenant 当前签发器（is_current=true 的私钥）。仅 Manager 内部调用，结果不外泄。"""
        self.ensure(tenant_id)
        row = self._current_row(tenant_id)
        kid, private_pem, _, _ = row
        return RS256TokenSigner(private_pem, kid=kid)

    def jwks(self, tenant_id: str) -> dict:
        """取 tenant 的 JWKS（含宽限期内所有公钥）。可下发用户端本地验签。

        返回多 kid 的 JWKS：用户端 RS256TokenVerifier.from_jwks 可同时持多个公钥，
        按 token header.kid 选择，支持平滑验签轮换（D23 red line）。
        """
        self.ensure(tenant_id)
        rows = self._active_public_rows(tenant_id)
        keys = []
        for kid, public_pem in rows:
            jwk = jwks_from_public_pem(kid, public_pem)["keys"][0]
            keys.append(jwk)
        return {"keys": keys}

    def verifier(self, tenant_id: str) -> RS256TokenVerifier:
        return RS256TokenVerifier.from_jwks(self.jwks(tenant_id))

    def resolved_public_key_for_kid(self, kid: str) -> ResolvedPublicKey | None:
        """按 kid 反查公钥并保留 registry tenant scope，供绑定验签使用。"""
        if ":" not in kid:
            return None
        tenant_id = kid.split(":", 1)[0]
        try:
            UUID(tenant_id)
        except (ValueError, AttributeError):
            return None
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            row = conn.execute(
                "SELECT tenant_id, public_pem FROM tenant_signing_key"
                " WHERE tenant_id = %s AND kid = %s"
                "   AND (is_current = true"
                "        OR (retired_at IS NOT NULL"
                "            AND retired_at > now() - interval '%s seconds'))",
                (tenant_id, kid, ROTATION_GRACE_SECONDS),
            ).fetchone()
        return ResolvedPublicKey(str(row[0]), row[1]) if row else None

    def public_pem_for_kid(self, kid: str) -> str | None:
        """兼容旧的 PEM 查询调用；生产验签应使用 resolved_public_key_for_kid。"""
        resolved = self.resolved_public_key_for_kid(kid)
        return resolved.public_pem if resolved else None
