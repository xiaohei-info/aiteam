"""provider 凭据/AI Relay 管理面业务编排（M5，04 §6.7，D18/D22）。

编排 repository（租户隔离）+ CryptoService（明文加密）+ 冲突/缺失判定 + 可见性授权语义。

核心红线（04 §6.7，D18）：
- 对外响应只回 provider_ref + 非敏感元数据（endpoint/可见性/version/能力目录），**绝不回明文 key/令牌**，
  也绝不回密文（密文亦非下发对象，防密钥泄露后重放）。
- 明文凭据在 service 层经 CryptoService.encrypt 加密后入 repository；service 内部按需解密给
  受控编排面（如按授权 pull provider 配置到用户端，由 Pi ModelRuntime 最小装配）。
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
    RuntimeProviderConfigOut,
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

    def __init__(self, repo: ProviderCredentialRepository, crypto: CryptoService, snapshot_service=None, operator=None):
        self._repo = repo
        self._crypto = crypto
        self._snapshot_service = snapshot_service
        self._operator = operator

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
            endpoint=body.endpoint,
            api_protocol=body.api_protocol,
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
            endpoint=body.endpoint,
            api_protocol=body.api_protocol,
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
        rows = _visible_rows(ctx, self._repo.list_all(ctx))
        return [_to_out(r) for r in rows]

    def list_providers_supporting_model(
        self, ctx: TenantContext, *, model: str
    ) -> list[ProviderCredentialOut]:
        """返回当前用户可见且 enabled 且支持指定 model 的 provider 列表。"""
        rows = _visible_rows(
            ctx, self._repo.list_providers_supporting_model(ctx, model=model)
        )
        return [_to_out(r) for r in rows]

    def runtime_config(self, ctx: TenantContext, *, employee_id: str) -> RuntimeProviderConfigOut:
        if self._snapshot_service is None:
            raise NotFound("runtime provider config is unavailable")
        ensure_runnable = getattr(self._snapshot_service, "_ensure_runnable", None)
        if ensure_runnable is None:
            raise NotFound("runtime provider config is unavailable")
        ensure_runnable(ctx, employee_id=employee_id)
        snapshot = self._snapshot_service.generate(ctx, member_id=ctx.user_id, employee_id=employee_id)
        policy = snapshot.model_policy
        provider_ref = policy.provider_ref
        model = policy.model
        if not provider_ref or not model or not policy.provider_version or not policy.model_version or policy.pricing is None or self._operator is None:
            raise NotFound("runtime provider config is unavailable")
        try:
            resolved = self._operator.resolve_tenant_access(
                tenant_id=ctx.tenant_id, provider_id=provider_ref, model_ids=[model]
            )
            access = resolved["access"]
            if model not in access.get("allowed_model_ids", []):
                raise NotFound("runtime provider model is unavailable")
            return RuntimeProviderConfigOut(
                base_url=resolved["relay_base_url"],
                api_protocol=resolved["api_protocol"],
                api_key=resolved["relay_token"],
                model=model,
                provider_ref=provider_ref,
                provider_version=policy.provider_version,
                model_version=policy.model_version,
                pricing=policy.pricing,
                version=int(access["version"]),
                model_capabilities=_runtime_model_capabilities(self._operator, provider_ref, model, policy.model_version),
            )
        except NotFound:
            raise
        except Exception as exc:  # noqa: BLE001 - fail closed without exposing upstream details
            raise NotFound("runtime provider config is unavailable") from exc

    def _require(self, ctx: TenantContext, credential_id: str) -> ProviderCredentialRow:
        row = self._repo.get(ctx, credential_id=credential_id)
        if row is None or not _is_visible(ctx, row):
            # 隐藏无权访问的行，避免通过 get 枚举凭据。
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


def _can_view_all(ctx: TenantContext) -> bool:
    """owner/enterprise_admin 可查看本租户全部凭据。"""
    return bool(set(ctx.roles) & set(_CRED_WRITE_ROLES))


def _is_visible(ctx: TenantContext, row: ProviderCredentialRow) -> bool:
    """按凭据可见性判断当前用户是否可见。"""
    return _can_view_all(ctx) or (
        row.visibility == "tenant"
        or row.visibility == "members" and ctx.user_id in row.allowed_member_ids
    )


def _visible_rows(
    ctx: TenantContext, rows: list[ProviderCredentialRow]
) -> list[ProviderCredentialRow]:
    """过滤本租户查询结果；租户边界仍由 repository/RLS 负责。"""
    if _can_view_all(ctx):
        return rows
    return [row for row in rows if _is_visible(ctx, row)]


def _runtime_model_capabilities(operator, provider_ref: str, model_id: str, model_version: int) -> dict[str, Any]:
    """Expose only non-sensitive capability fields needed by the local Pi model."""
    try:
        catalog = operator.list_platform_catalog()
    except Exception:  # noqa: BLE001 - runtime config remains compatible with older catalogs
        return {}
    models = catalog.get("models", []) if isinstance(catalog, dict) else []
    if not isinstance(models, list):
        return {}
    for item in models:
        if not isinstance(item, dict):
            continue
        model = item.get("model") if isinstance(item.get("model"), dict) else item
        if not isinstance(model, dict) or model.get("provider_id") != provider_ref or model.get("model_id") != model_id or model.get("version") != model_version:
            continue
        raw = model.get("capabilities")
        if not isinstance(raw, dict):
            return {}
        output: dict[str, Any] = {}
        for key in ("context_window", "max_tokens"):
            value = raw.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10_000_000:
                output[key] = value
        if isinstance(raw.get("reasoning"), bool):
            output["reasoning"] = raw["reasoning"]
        input_modes = raw.get("input") or raw.get("input_modalities")
        if isinstance(input_modes, list):
            modes = [mode for mode in input_modes if mode in {"text", "image"}]
            if modes:
                output["input"] = list(dict.fromkeys(modes))
        thinking_map = raw.get("thinking_level_map")
        if isinstance(thinking_map, dict):
            clean_map = {str(key): value for key, value in thinking_map.items() if key in {"off", "minimal", "low", "medium", "high", "xhigh", "max"} and (value is None or isinstance(value, str))}
            if clean_map:
                output["thinking_level_map"] = clean_map
        return output
    return {}


def _to_out(row: ProviderCredentialRow) -> ProviderCredentialOut:
    """行 → 出参。**绝不**回明文 secret，也绝不回密文（红线：不下发明文 key）。"""
    return ProviderCredentialOut(
        credential_id=row.credential_id,
        provider_ref=row.provider_ref,
        display_name=row.display_name,
        endpoint=row.endpoint,
        api_protocol=row.api_protocol,
        visibility=row.visibility,
        allowed_member_ids=row.allowed_member_ids,
        supported_models=[_capability_from_dict(c) for c in row.supported_models],
        model_catalog_source=row.model_catalog_source,
        version=row.version,
    )


def build_provider_credential_service(router: PgTenantRouter, crypto: CryptoService, snapshot_service=None, operator=None) -> ProviderCredentialService:
    return ProviderCredentialService(ProviderCredentialRepository(router), crypto, snapshot_service, operator)
