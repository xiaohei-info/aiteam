"""provider 凭据/AI Relay 管理面 CRUD + 加密 + 明文不下发验收（M5，04 §6.7，D18/D22）。

非 integration（默认门必跑，不依赖 PG）：
- schema 明文隔离：Out 不含 secret/encrypted_secret 字段（红线：不下发明文 key）。
- 业务编排：明文经 CryptoService 加密后入 repository（明文不落库），跨租户不可见，
  冲突/缺失/成员可见性守卫、member 写 403。
- 红线断言：GET/LIST/UPDATE 响应里绝不出现明文 key/令牌。

integration（真 PG）：CRUD 端到端 + 跨租户 RLS 隔离 + version 自增 + 响应无明文。
"""

from __future__ import annotations

import pytest

from shared.contracts.tenancy import TenantContext
from shared.crypto import CryptoService
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.provider_credential_repository import ProviderCredentialRow
from manager_service.provider_credential_service import ProviderCredentialService
from manager_service.schemas_provider import (
    ProviderCredentialCreate,
    ProviderCredentialOut,
    ProviderCredentialUpdate,
)

_PLAINTEXT_SECRET = "sk-relay-超机密-令牌-1234567890"


# ---- schema 红线：Out 绝不含明文 / 密文 ----


def test_out_schema_carries_no_secret_field():
    """ProviderCredentialOut 不含 secret/encrypted_secret/密文 字段（红线：不下发明文 key）。"""
    fields = set(ProviderCredentialOut.model_fields.keys())
    forbidden = {"secret", "encrypted_secret", "ciphertext", "token", "api_key"}
    assert not (fields & forbidden), f"ProviderCredentialOut 含敏感字段: {fields & forbidden}"


def test_create_schema_carries_plaintext_secret():
    """写入面携带明文 secret（入参即焚，service 加密后明文不落库）。"""
    body = ProviderCredentialCreate(provider_ref="relay-default", secret=_PLAINTEXT_SECRET)
    assert body.secret == _PLAINTEXT_SECRET


def test_visibility_members_requires_ids():
    """visibility=members 必须带非空 allowed_member_ids。"""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ProviderCredentialCreate(
            provider_ref="r", secret="x", visibility="members", allowed_member_ids=[],
        )


# ---- 业务编排（内存伪 repository + 真 CryptoService，不依赖 PG）----


class _FakeRepo:
    """内存伪 repository：按 tenant_id 分桶，模拟 RLS 跨租户不可见。tenant_id 只从 ctx 读。

    记录传入的密文，供测试断言"明文未落库、密文已落库"。
    """

    def __init__(self):
        self._store: dict[str, dict[str, ProviderCredentialRow]] = {}

    def _bucket(self, ctx: TenantContext) -> dict[str, ProviderCredentialRow]:
        return self._store.setdefault(ctx.tenant_id, {})

    def create(self, ctx, **kw):
        import uuid
        row = ProviderCredentialRow(
            credential_id=str(uuid.uuid4()), provider_ref=kw["provider_ref"],
            display_name=kw["display_name"], mode=kw["mode"], endpoint=kw["endpoint"],
            encrypted_secret=kw["encrypted_secret"], visibility=kw["visibility"],
            allowed_member_ids=kw["allowed_member_ids"], version=1,
        )
        self._bucket(ctx)[row.credential_id] = row
        return row

    def get(self, ctx, *, credential_id):
        return self._bucket(ctx).get(credential_id)

    def get_by_ref(self, ctx, *, provider_ref):
        for r in self._bucket(ctx).values():
            if r.provider_ref == provider_ref:
                return r
        return None

    def update(self, ctx, *, credential_id, **kw):
        b = self._bucket(ctx)
        if credential_id not in b:
            return None
        old = b[credential_id]
        row = ProviderCredentialRow(
            credential_id=old.credential_id, provider_ref=old.provider_ref,
            display_name=kw["display_name"], mode=kw["mode"], endpoint=kw["endpoint"],
            encrypted_secret=kw["encrypted_secret"], visibility=kw["visibility"],
            allowed_member_ids=kw["allowed_member_ids"], version=old.version + 1,
        )
        b[credential_id] = row
        return row

    def delete(self, ctx, *, credential_id):
        return self._bucket(ctx).pop(credential_id, None) is not None

    def list_all(self, ctx):
        return list(self._bucket(ctx).values())


def _crypto() -> CryptoService:
    """每次测试派生独立 Fernet 实例（避免 env key 干扰，确定性隔离）。"""
    from cryptography.fernet import Fernet
    return CryptoService(Fernet(Fernet.generate_key()))


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


def _create_body(**overrides) -> ProviderCredentialCreate:
    base = {
        "provider_ref": "relay-default",
        "display_name": "默认 AI Relay",
        "mode": "relay",
        "endpoint": "https://relay.example.local/v1",
        "visibility": "tenant",
        "secret": _PLAINTEXT_SECRET,
    }
    base.update(overrides)
    return ProviderCredentialCreate(**base)


def test_crud_roundtrip_plaintext_never_stored_or_returned():
    """明文经加密落库；响应不含明文/密文；version 自增。"""
    repo = _FakeRepo()
    svc = ProviderCredentialService(repo, _crypto())
    ctx = _ctx("t-a")

    created = svc.create(ctx, _create_body())
    assert created.provider_ref == "relay-default"
    assert created.version == 1

    # 红线：出参不含明文 / 密文
    assert created.model_dump().get("secret") is None
    assert "encrypted_secret" not in created.model_dump()
    dumped = created.model_dump(mode="json")
    assert _PLAINTEXT_SECRET not in str(dumped)

    # 明文未落库（伪 repo 存的是密文，与明文不同）
    row = repo.get(ctx, credential_id=created.credential_id)
    assert row.encrypted_secret != _PLAINTEXT_SECRET.encode()
    assert _PLAINTEXT_SECRET not in row.encrypted_secret.decode("utf-8", errors="ignore")

    got = svc.get(ctx, credential_id=created.credential_id)
    assert got.credential_id == created.credential_id

    updated = svc.update(
        ctx,
        ProviderCredentialUpdate(
            display_name="改名", mode="direct", endpoint="https://api.openai.example/v1",
            visibility="tenant", secret="sk-new-plain-987",
        ),
        credential_id=created.credential_id,
    )
    assert updated.display_name == "改名"
    assert updated.version == 2
    # 旧明文不应出现在更新后响应
    assert "sk-new-plain-987" not in str(updated.model_dump(mode="json"))

    svc.delete(ctx, credential_id=created.credential_id)
    with pytest.raises(NotFound):
        svc.get(ctx, credential_id=created.credential_id)


def test_cross_tenant_isolation_not_visible():
    """跨租户：t-a 建的凭据，t-b 看不到/改不到/删不掉（D22 + RLS 语义）。"""
    svc = ProviderCredentialService(_FakeRepo(), _crypto())
    ctx_a = _ctx("t-a")
    ctx_b = _ctx("t-b")
    created = svc.create(ctx_a, _create_body())

    with pytest.raises(NotFound):
        svc.get(ctx_b, credential_id=created.credential_id)
    with pytest.raises(NotFound):
        svc.update(
            ctx_b,
            ProviderCredentialUpdate(
                display_name="hack", mode="relay", endpoint=None,
                visibility="tenant", secret="x",
            ),
            credential_id=created.credential_id,
        )
    with pytest.raises(NotFound):
        svc.delete(ctx_b, credential_id=created.credential_id)
    assert svc.get(ctx_a, credential_id=created.credential_id) is not None


def test_provider_ref_conflict_within_tenant():
    svc = ProviderCredentialService(_FakeRepo(), _crypto())
    svc.create(_ctx("t-a"), _create_body(provider_ref="dup"))
    with pytest.raises(Conflict):
        svc.create(_ctx("t-a"), _create_body(provider_ref="dup"))


def test_same_provider_ref_across_tenants_allowed():
    """同 provider_ref 属不同 tenant 是不同凭据（unique(tenant_id, provider_ref)）。"""
    svc = ProviderCredentialService(_FakeRepo(), _crypto())
    svc.create(_ctx("t-a"), _create_body(provider_ref="shared"))
    created_b = svc.create(_ctx("t-b"), _create_body(provider_ref="shared"))
    assert created_b.provider_ref == "shared"


def test_member_cannot_write_credential():
    """凭据写操作需 owner/enterprise_admin；member → 403（03 §9.7）。"""
    svc = ProviderCredentialService(_FakeRepo(), _crypto())
    ctx_member = _ctx("t-a", roles=["member"])
    with pytest.raises(Forbidden):
        svc.create(ctx_member, _create_body())
    # member 读允许（get/list 无角色门）
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = svc.create(ctx_owner, _create_body())
    assert svc.get(ctx_member, credential_id=created.credential_id).provider_ref == "relay-default"


def test_visibility_members_enforced_in_service():
    """service 层守卫：visibility=members 但空 allowed_member_ids → Conflict。"""
    from manager_service.provider_credential_service import _ensure_visibility_members
    # schema 已在入参层拦截，service 层作双保险
    with pytest.raises(Conflict):
        _ensure_visibility_members("members", [])


def test_encryption_roundtrip_via_crypto_service():
    """CryptoService 加密-解密对称；明文与密文不同。"""
    crypto = _crypto()
    token = crypto.encrypt(_PLAINTEXT_SECRET)
    assert token != _PLAINTEXT_SECRET.encode()
    assert crypto.decrypt(token) == _PLAINTEXT_SECRET
