"""provider 凭据租户作用域数据访问（M5，04 §6.7，D18/D22）。

铁律：与 EmployeeConfigRepository 一致——所有方法以 TenantContext 为隔离边界，tenant_id 只从
ctx 读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离（04 §6.1.1）。

明文凭据在 service 层经 CryptoService 加密后以密文（bytea）入本层；本层只搬运密文，
不解密、不读明文。解密仅在受控编排面（service 解密给 pull/快照）按需发生（04 §6.7）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


@dataclass(frozen=True)
class ProviderCredentialRow:
    """provider 凭据行（含密文 secret；对外输出时由 service 剥离明文/密文）。"""

    credential_id: str
    provider_ref: str
    display_name: str
    endpoint: str | None
    api_protocol: str
    encrypted_secret: bytes  # 密文，绝不下发明文
    visibility: str
    allowed_member_ids: list[str]
    supported_models: list[dict[str, Any]]  # 能力目录（model 等非敏感声明）
    model_catalog_source: str  # 能力目录来源（manual | discovery）
    version: int


_COLUMNS = (
    "id, provider_ref, display_name, endpoint, api_protocol, encrypted_secret, "
    "visibility, allowed_member_ids, supported_models, model_catalog_source, version"
)


def _row_to_credential(row: Any) -> ProviderCredentialRow:
    return ProviderCredentialRow(
        credential_id=str(row[0]),
        provider_ref=row[1],
        display_name=row[2],
        endpoint=row[3],
        api_protocol=row[4] or "openai-completions",
        encrypted_secret=bytes(row[5]) if row[5] is not None else b"",
        visibility=row[6],
        allowed_member_ids=list(row[7] or []),
        supported_models=list(row[8] or []),
        model_catalog_source=row[9] or "manual",
        version=row[10],
    )


def _dump_supported_models(supported_models: list[dict[str, Any]]) -> str:
    """将能力目录序列化为 jsonb .payload（保序、去 None 键由调用方保证）。"""
    return json.dumps(supported_models, ensure_ascii=False)


class ProviderCredentialRepository:
    """provider 凭据的租户内读写。tenant_id 全程取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
        self,
        ctx: TenantContext,
        *,
        provider_ref: str,
        display_name: str,
        endpoint: str | None,
        encrypted_secret: bytes,
        visibility: str,
        allowed_member_ids: list[str],
        supported_models: list[dict[str, Any]],
        model_catalog_source: str,
        api_protocol: str = "openai-completions",
    ) -> ProviderCredentialRow:
        """在本 tenant 建 provider 凭据行。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                INSERT INTO provider_credential (
                    tenant_id, provider_ref, display_name, endpoint, api_protocol,
                    encrypted_secret, visibility, allowed_member_ids,
                    supported_models, model_catalog_source
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING """ + _COLUMNS,
                (
                    ctx.tenant_id, provider_ref, display_name, endpoint, api_protocol,
                    encrypted_secret, visibility, json.dumps(allowed_member_ids),
                    _dump_supported_models(supported_models), model_catalog_source,
                ),
            ).fetchone()
        return _row_to_credential(row)

    def get(self, ctx: TenantContext, *, credential_id: str) -> ProviderCredentialRow | None:
        """按 id 取本 tenant 内凭据；跨 tenant 因 RLS 看不到（04 §6.1.1）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _COLUMNS + " FROM provider_credential WHERE id = %s",
                (credential_id,),
            ).fetchone()
        return _row_to_credential(row) if row is not None else None

    def get_by_ref(self, ctx: TenantContext, *, provider_ref: str) -> ProviderCredentialRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _COLUMNS + " FROM provider_credential WHERE provider_ref = %s",
                (provider_ref,),
            ).fetchone()
        return _row_to_credential(row) if row is not None else None

    def update(
        self,
        ctx: TenantContext,
        *,
        credential_id: str,
        display_name: str,
        endpoint: str | None,
        encrypted_secret: bytes,
        visibility: str,
        allowed_member_ids: list[str],
        supported_models: list[dict[str, Any]],
        model_catalog_source: str,
        api_protocol: str = "openai-completions",
    ) -> ProviderCredentialRow | None:
        """改写本 tenant 内凭据（version 由触发器自增）。跨 tenant 行 RLS 不可见。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                """
                UPDATE provider_credential SET
                    display_name = %s, endpoint = %s, api_protocol = %s,
                    encrypted_secret = %s, visibility = %s, allowed_member_ids = %s,
                    supported_models = %s, model_catalog_source = %s
                WHERE id = %s
                RETURNING """ + _COLUMNS,
                (
                    display_name, endpoint, api_protocol, encrypted_secret, visibility,
                    json.dumps(allowed_member_ids), _dump_supported_models(supported_models),
                    model_catalog_source, credential_id,
                ),
            ).fetchone()
        return _row_to_credential(row) if row is not None else None

    def delete(self, ctx: TenantContext, *, credential_id: str) -> bool:
        """删本 tenant 内凭据行。返回是否命中（跨 tenant 行 RLS 不可见→False）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "DELETE FROM provider_credential WHERE id = %s RETURNING id", (credential_id,)
            ).fetchone()
        return row is not None

    def list_all(self, ctx: TenantContext) -> list[ProviderCredentialRow]:
        """列本 tenant 内全部凭据（RLS 自动限定本 tenant）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _COLUMNS + " FROM provider_credential ORDER BY created_at"
            ).fetchall()
        return [_row_to_credential(r) for r in rows]

    def list_models_by_tenant(self, ctx: TenantContext) -> list[dict[str, Any]]:
        """列本 tenant 全部 provider 的能力目录（含 provider_ref 关联）。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                """
                SELECT provider_ref, supported_models, model_catalog_source
                FROM provider_credential
                ORDER BY created_at
                """
            ).fetchall()
        return [
            {
                "provider_ref": r[0],
                "supported_models": list(r[1] or []),
                "model_catalog_source": r[2] or "manual",
            }
            for r in rows
        ]

    def list_providers_supporting_model(
        self, ctx: TenantContext, *, model: str
    ) -> list[ProviderCredentialRow]:
        """返回本 tenant 内 enabled 且支持指定 model 的 provider 列表（供招募自动匹配 provider_ref）。

        匹配语义：supported_models 数组中存在 enabled=true 且 model=<model> 的条目。
        使用 jsonb_path_exists（jsonpath）做索引友好查询；无匹配返回 []。
        """
        with self._router.session(ctx) as s:
            rows = s.execute(
                """
                SELECT """ + _COLUMNS + """
                FROM provider_credential
                WHERE jsonb_path_exists(
                    supported_models,
                    '$[*] ? (@.model == $model && @.enabled == true)',
                    %s::jsonb
                )
                ORDER BY created_at
                """,
                (json.dumps({"model": model}),),
            ).fetchall()
        return [_row_to_credential(r) for r in rows]
