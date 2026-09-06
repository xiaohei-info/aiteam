"""Passkey 凭据存储（issue AITEAM-253，「Passkey (WebAuthn) 注册和登录」缺口）。

替代旧 api/passkeys.json 文件凭据库，落 PG（passkey_credential，租户 RLS）。
tenant_id 只从 TenantContext 取（D22）；任何访问都不经手写 tenant 过滤。

对外只暴露公钥元数据（不暴露私钥——私钥永不上传服务端，这是 WebAuthn 的性质）。
"""

from __future__ import annotations

import time

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


class PasskeyCredentialRow:
    __slots__ = ("id", "tenant_id", "user_id", "credential_id", "public_key_pem",
                 "sign_count", "label", "created_at", "last_used_at")

    def __init__(self, *, id, tenant_id, user_id, credential_id, public_key_pem,
                 sign_count, label, created_at, last_used_at):
        self.id = id
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.credential_id = credential_id
        self.public_key_pem = public_key_pem
        self.sign_count = sign_count
        self.label = label
        self.created_at = created_at
        self.last_used_at = last_used_at


class PasskeyStore:
    """passkey_credential 租户作用域读写。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def list_for_user(self, ctx: TenantContext, user_id: str) -> list[PasskeyCredentialRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, tenant_id, user_id, credential_id, public_key_pem, "
                "       sign_count, label, created_at, last_used_at "
                "FROM passkey_credential WHERE user_id = %s ORDER BY created_at",
                (user_id,),
            ).fetchall()
        return [_row(r) for r in rows]

    def find_by_credential(self, ctx: TenantContext, credential_id: str) -> PasskeyCredentialRow | None:
        with self._router.session(ctx) as s:
            r = s.execute(
                "SELECT id, tenant_id, user_id, credential_id, public_key_pem, "
                "       sign_count, label, created_at, last_used_at "
                "FROM passkey_credential WHERE credential_id = %s",
                (credential_id,),
            ).fetchone()
        return _row(r) if r else None

    def insert(self, ctx: TenantContext, *, user_id, credential_id, public_key_pem, sign_count, label) -> str:
        with self._router.session(ctx) as s:
            r = s.execute(
                "INSERT INTO passkey_credential "
                "  (tenant_id, user_id, credential_id, public_key_pem, sign_count, label) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (ctx.tenant_id, user_id, credential_id, public_key_pem, sign_count, label),
            ).fetchone()
        return str(r[0])

    def update_usage(self, ctx: TenantContext, *, credential_id, sign_count) -> None:
        with self._router.session(ctx) as s:
            s.execute(
                "UPDATE passkey_credential "
                "SET sign_count = %s, last_used_at = now() "
                "WHERE credential_id = %s",
                (sign_count, credential_id),
            )

    def delete(self, ctx: TenantContext, *, credential_id) -> bool:
        from shared.errors import Conflict
        with self._router.session(ctx) as s:
            s.execute("SELECT id FROM app_user WHERE id = %s FOR UPDATE", (ctx.user_id,))
            own = s.execute("SELECT 1 FROM passkey_credential WHERE credential_id = %s AND user_id = %s", (credential_id, ctx.user_id)).fetchone()
            if own is None:
                return False
            alternative = s.execute(
                "SELECT 1 FROM auth_identity WHERE user_id = %s AND "
                "((provider IN ('phone', 'password') AND secret IS NOT NULL) OR provider = 'oauth') "
                "UNION ALL SELECT 1 FROM passkey_credential WHERE user_id = %s AND credential_id <> %s LIMIT 1",
                (ctx.user_id, ctx.user_id, credential_id),
            ).fetchone()
            if alternative is None:
                raise Conflict("add another login method before removing the last one")
            cur = s.execute("DELETE FROM passkey_credential WHERE credential_id = %s AND user_id = %s", (credential_id, ctx.user_id))
            return cur.rowcount > 0


def _row(r) -> PasskeyCredentialRow:
    return PasskeyCredentialRow(
        id=str(r[0]), tenant_id=str(r[1]), user_id=str(r[2]), credential_id=r[3],
        public_key_pem=r[4], sign_count=r[5], label=r[6], created_at=r[7], last_used_at=r[8],
    )
