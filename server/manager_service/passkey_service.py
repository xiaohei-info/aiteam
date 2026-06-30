"""Passkey 编排服务（issue AITEAM-253）。

把 ceremony（纯校验） + PasskeyStore（PG 凭据） + TenantAuthRepository（auth_identity 映射）拼成
端到端的注册/登录流程。tenant_id 只经 TenantContext 出入（D22）。

流程：
- 注册：需已登录用户（凭 token 拿 user_id + roles）。校验 WebAuthn 注册响应后落 passkey_credential，
  并幂等挂一条 auth_identity(provider=passkey)。
- 登录：公开端点。凭 WebAuthn 登录响应中的 credential_id 经 PasskeyStore 定位 user，校验断言后 issue_token。
  此路径为 usernameless/resident-credential 登录（靠 credential_id 定位用户）。
"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.errors import Unauthorized, ValidationProblem

from . import passkey_ceremony as ceremony
from .auth_service import AuthResult
from .login_audit import LoginAuditRepository, record_login_attempt
from .passkey_store import PasskeyStore
from .repository import TenantAuthRepository


class PasskeyService:
    def __init__(
        self,
        *,
        auth_repo: TenantAuthRepository,
        store: PasskeyStore,
        audit: LoginAuditRepository,
        issuer,
    ):
        """
        issuer: 签 token 的可调用对象，签 (tenant_id, user_id, roles) -> AuthResult
        """
        self._auth_repo = auth_repo
        self._store = store
        self._audit = audit
        self._issuer = issuer

    # ---- 注册（需已登录用户）----
    def registration_options(self, ctx: TenantContext, user_id: str) -> dict:
        existing = self._store.list_for_user(ctx, user_id)
        ids = [c.credential_id for c in existing]
        return ceremony.registration_options(ctx.tenant_id, existing_credential_ids=ids)

    def finish_registration(self, ctx: TenantContext, user_id: str, payload: dict) -> dict:
        result = ceremony.finish_registration(payload, rp_id=ctx.tenant_id)
        credential_id = result["credential_id"]
        if self._store.find_by_credential(ctx, credential_id):
            raise ValidationProblem("passkey already registered")
        self._store.insert(
            ctx,
            user_id=user_id,
            credential_id=credential_id,
            public_key_pem=result["public_key_pem"],
            sign_count=result["sign_count"],
            label=result["label"],
        )
        self._auth_repo.find_or_create_passkey_identity(ctx, user_id=user_id)
        return {"credential_id": credential_id, "label": result["label"]}

    # ---- 登录（公开）----
    def authentication_options(self, tenant_id: str, account: str | None) -> dict:
        ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
        if account:
            from shared.contracts.enums import AuthProvider
            identity = self._auth_repo.find_identity(
                ctx, provider=AuthProvider.PHONE, external_id=account
            )
            if identity is None:
                raise Unauthorized("account not found")
            user_id = identity.user_id
        else:
            user_id = None
        if user_id:
            creds = self._store.list_for_user(ctx, user_id)
        else:
            creds = []  # usernameless: 让客户端从 resident credential 自选
        allow = [c.credential_id for c in creds]
        return ceremony.authentication_options(tenant_id, allow_credential_ids=allow)

    def finish_login(self, tenant_id: str, payload: dict) -> AuthResult:
        ctx = TenantContext(tenant_id=tenant_id, user_id="anon", roles=[])
        cred_id = payload.get("id") or payload.get("rawId")
        if not isinstance(cred_id, str) or not cred_id:
            record_login_attempt(
                self._audit, ctx, provider="passkey", external_id=None,
                actor="anon", ip=payload.get("ip"), success=False,
                detail="missing credential id",
            )
            raise ValidationProblem("Missing passkey credential id")
        cred = self._store.find_by_credential(ctx, cred_id)
        if cred is None:
            record_login_attempt(
                self._audit, ctx, provider="passkey", external_id=cred_id,
                actor="anon", ip=payload.get("ip"), success=False,
                detail="unknown credential",
            )
            raise Unauthorized("Unknown passkey")
        try:
            res = ceremony.finish_login(
                payload, rp_id=tenant_id,
                stored_pem=cred.public_key_pem, old_sign_count=cred.sign_count,
            )
            new_count = res["sign_count"]
        except Exception as exc:
            record_login_attempt(
                self._audit, ctx, provider="passkey", external_id=cred_id,
                actor=cred.user_id, ip=payload.get("ip"), success=False,
                detail="verification failed",
            )
            raise
        self._store.update_usage(ctx, credential_id=cred_id, sign_count=new_count)
        identity = self._auth_repo.find_user(ctx, user_id=cred.user_id)
        if identity is None:
            record_login_attempt(
                self._audit, ctx, provider="passkey", external_id=cred_id,
                actor=cred.user_id, ip=payload.get("ip"), success=False,
                detail="account missing",
            )
            raise Unauthorized("passkey credential has no matching account")
        record_login_attempt(
            self._audit, ctx, provider="passkey", external_id=cred_id,
            actor=cred.user_id, ip=payload.get("ip"), success=True,
            detail="sign_count=%d" % new_count,
        )
        return self._issuer(ctx.tenant_id, identity.user_id, identity.roles)
