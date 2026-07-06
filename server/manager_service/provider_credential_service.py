"""provider 凭据/AI Relay 管理面业务编排（M5，04 §6.7，D18/D22）。

编排 repository（租户隔离）+ CryptoService（明文加密）+ 冲突/缺失判定 + 可见性授权语义。

核心红线（04 §6.7，D18）：
- 对外响应只回 provider_ref + 非敏感元数据（endpoint/可见性/version/能力目录），**绝不回明文 key/令牌**，
  也绝不回密文（密文亦非下发对象，防密钥泄露后重放）。
- 明文凭据在 service 层经 CryptoService.encrypt 加密后入 repository；service 内部按需解密给
  受控编排面（如 pull 已授权 provider 配置到用户端 local_capability_cache，由 Driver 最小注入）。
- 可见性/成员级授权真相态：visibility=tenant（租户内全员可用）| members（仅 allowed_member_ids）。
- 本地最小注入语义不在控制面执行 provider 调用（Manager 不调用 LLM/Relay，04 §6.7 澄清）。
- tenant_id 全程经 TenantContext，不手写过滤（D22）。
"""

from __future__ import annotations

from typing import Any

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.crypto import CryptoService
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound

from .provider_credential_repository import ProviderCredentialRepository, ProviderCredentialRow
from .schemas_provider import (
    ProviderCredentialCreate,
    ProviderCredentialOut,
    ProviderCredentialUpdate,
    ProviderModelCapability,
)

# 配置写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_CRED_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


def _capability_to_dict(cap: ProviderModelCapability) -> dict[str, Any]:
    """能力声明 → 可 JSON 序列化的 dict（入库 jsonb 用）。"""
    return {
        "model": cap.model,
        "display_name": cap.display_name,
        "enabled": cap.enabled,
        "capabilities": dict(cap.capabilities) if cap.capabilities else {},
    }


def _capability_from_dict(raw: dict[str, Any]) -> ProviderModelCapability:
    """jsonb 条目 → 能力声明（容忍缺失字段，回退到 schema 默认值）。"""
    return ProviderModelCapability(
        model=raw.get("model", ""),
        display_name=raw.get("display_name", "") or "",
        enabled=bool(raw.get("enabled", True)),
        capabilities=dict(raw.get("capabilities") or {}),
    )


class ProviderCredentialService:
    """provider 凭据 CRUD 编排 + 加密 + 明文不下发。"""

    def __init__(self, repo: ProviderCredentialRepository, crypto: CryptoService):
        self._repo = repo
        self._crypto = crypto

    def create(self, ctx: TenantContext, body: ProviderCredentialCreate) -> ProviderCredentialOut:
        _ensure_can_write(ctx)
        if self._repo.get_by_ref(ctx, provider_ref=body.provider_ref) is not None:
            raise Conflict("provider_ref already exists in this tenant")
        _ensure_visibility_members(body.visibility, body.allowed_member_ids)
        encrypted = self._crypto.encrypt(body.secret)
        row = self._repo.create(
            ctx,
            provider_ref=body.provider_ref,
            display_name=body.display_name,
            mode=body.mode,
            endpoint=body.endpoint,
            encrypted_secret=encrypted,
            visibility=body.visibility,
            allowed_member_ids=body.allowed_member_ids,
            supported_models=[_capability_to_dict(c) for c in body.supported_models],
            model_catalog_source=body.model_catalog_source,
        )
        return _to_out(row)

    def get(self, ctx: TenantContext, *, credential_id: str) -> ProviderCredentialOut:
        row = self._require(ctx, credential_id)
        return _to_out(row)

    def update(
        self,
        ctx: TenantContext,
        body: ProviderCredentialUpdate,
        *,
        credential_id: str,
    ) -> ProviderCredentialOut:
        _ensure_can_write(ctx)
        if self._require(ctx, credential_id) is None:
            raise NotFound("provider credential not found in this tenant")
        _ensure_visibility_members(body.visibility, body.allowed_member_ids)
        encrypted = self._crypto.encrypt(body.secret)
        row = self._repo.update(
            ctx,
            credential_id=credential_id,
            display_name=body.display_name,
            mode=body.mode,
            endpoint=body.endpoint,
            encrypted_secret=encrypted,
            visibility=body.visibility,
            allowed_member_ids=body.allowed_member_ids,
            supported_models=[_capability_to_dict(c) for c in body.supported_models],
            model_catalog_source=body.model_catalog_source,
        )
        if row is None:  # 双保险：RLS 下跨 tenant 删除/不可见
            raise NotFound("provider credential not found in this tenant")
        return _to_out(row)

    def delete(self, ctx: TenantContext, *, credential_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, credential_id=credential_id):
            raise NotFound("provider credential not found in this tenant")

    def list_all(self, ctx: TenantContext) -> list[ProviderCredentialOut]:
        return [_to_out(r) for r in self._repo.list_all(ctx)]

    def list_providers_supporting_model(
        self, ctx: TenantContext, *, model: str
    ) -> list[ProviderCredentialOut]:
        """返回本 tenant 内 enabled 且支持指定 model 的 provider 列表（供招募自动匹配 provider_ref）。"""
        return [_to_out(r) for r in self._repo.list_providers_supporting_model(ctx, model=model)]

    def _require(self, ctx: TenantContext, credential_id: str) -> ProviderCredentialRow:
        row = self._repo.get(ctx, credential_id=credential_id)
        if row is None:
            raise NotFound("provider credential not found in this tenant")
        return row


def _ensure_can_write(ctx: TenantContext) -> None:
    """凭据写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_CRED_WRITE_ROLES):
        raise Forbidden("provider credential write requires owner or enterprise_admin")


def _ensure_visibility_members(visibility: str, allowed_member_ids: list[str]) -> None:
    """可见性语义守卫：visibility=members 时 allowed_member_ids 须非空。"""
    if visibility == "members" and not allowed_member_ids:
        raise Conflict("visibility=members requires non-empty allowed_member_ids")


def _to_out(row: ProviderCredentialRow) -> ProviderCredentialOut:
    """行 → 出参。**绝不**回明文 secret，也绝不回密文（红线：不下发明文 key）。"""
    return ProviderCredentialOut(
        credential_id=row.credential_id,
        provider_ref=row.provider_ref,
        display_name=row.display_name,
        mode=row.mode,
        endpoint=row.endpoint,
        visibility=row.visibility,
        allowed_member_ids=row.allowed_member_ids,
        supported_models=[_capability_from_dict(c) for c in row.supported_models],
        model_catalog_source=row.model_catalog_source,
        version=row.version,
    )


def build_provider_credential_service(router: PgTenantRouter, crypto: CryptoService) -> ProviderCredentialService:
    return ProviderCredentialService(ProviderCredentialRepository(router), crypto)
