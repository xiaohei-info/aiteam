"""provider_credential_repository.py branch coverage (issue #234, target >=90%)."""

from __future__ import annotations

import json

from manager_service.provider_credential_repository import (
    ProviderCredentialRepository,
    ProviderCredentialRow,
    _dump_supported_models,
    _row_to_credential,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _models(models=None):
    return models or [
        {"model": "gpt-4o", "display_name": "GPT-4o", "enabled": True, "capabilities": {}},
    ]


def _cred_row(cid="c-1", ref="relay-default", name="Default", mode="relay",
              endpoint="https://relay.local", secret=b"encrypted", vis="tenant",
              mems=None, models=None, catalog="manual", ver=1):
    # 列顺序必须与 repository _COLUMNS 一致：
    # id, provider_ref, display_name, mode, endpoint, encrypted_secret,
    # visibility, allowed_member_ids, supported_models, model_catalog_source, version
    return (cid, ref, name, mode, endpoint, secret, vis,
            mems or ["m-1"], models or _models(), catalog, ver)


def test_create_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    row = ProviderCredentialRepository(router).create(
        ctx(), provider_ref="relay-default", display_name="Default", mode="relay",
        endpoint="https://relay.local", encrypted_secret=b"encrypted", visibility="tenant",
        allowed_member_ids=["m-1"], supported_models=_models(), model_catalog_source="manual",
    )
    assert isinstance(row, ProviderCredentialRow)
    assert row.credential_id == "c-1"
    assert row.provider_ref == "relay-default"
    assert row.version == 1
    assert row.supported_models[0]["model"] == "gpt-4o"
    assert row.model_catalog_source == "manual"


def test_create_serializes_supported_models():
    """create 应把 supported_models 序列化为 json 字符串传入 SQL。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    ProviderCredentialRepository(router).create(
        ctx(), provider_ref="r", display_name="D", mode="relay",
        endpoint=None, encrypted_secret=b"x", visibility="tenant",
        allowed_member_ids=[], supported_models=_models([{"model": "gpt-4o"}]),
        model_catalog_source="discovery",
    )
    sql, params = router.executed[-1]
    assert "supported_models" in sql
    assert "model_catalog_source" in sql
    # supported_models 参数是 json 字符串（index 8）；model_catalog_source 是裸字符串（index 9）
    assert params[8] == json.dumps([{"model": "gpt-4o"}], ensure_ascii=False)
    assert params[9] == "discovery"


def test_get_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    row = ProviderCredentialRepository(router).get(ctx(), credential_id="c-1")
    assert row is not None
    assert row.visibility == "tenant"


def test_get_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).get(ctx(), credential_id="x") is None


def test_get_by_ref_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row(ref="shared")))
    row = ProviderCredentialRepository(router).get_by_ref(ctx(), provider_ref="shared")
    assert row is not None
    assert row.provider_ref == "shared"

def test_get_by_ref_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).get_by_ref(ctx(), provider_ref="x") is None


def test_update_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row(name="Updated", ver=2)))
    row = ProviderCredentialRepository(router).update(
        ctx(), credential_id="c-1", display_name="Updated", mode="direct",
        endpoint="https://api.local", encrypted_secret=b"new", visibility="members",
        allowed_member_ids=["m-2"], supported_models=_models(), model_catalog_source="manual",
    )
    assert row is not None
    assert row.display_name == "Updated"
    assert row.version == 2
    assert row.model_catalog_source == "manual"


def test_update_passes_new_columns():
    """update SQL 必须包含 supported_models / model_catalog_source 赋值。"""
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_cred_row()))
    ProviderCredentialRepository(router).update(
        ctx(), credential_id="c-1", display_name="x", mode="relay",
        endpoint=None, encrypted_secret=b"x", visibility="tenant", allowed_member_ids=[],
        supported_models=_models([{"model": "claude-3-5-sonnet"}]), model_catalog_source="discovery",
    )
    sql, params = router.executed[-1]
    assert "supported_models" in sql
    assert "model_catalog_source" in sql


def test_update_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    row = ProviderCredentialRepository(router).update(
        ctx(), credential_id="x", display_name="X", mode="relay",
        endpoint=None, encrypted_secret=b"x", visibility="tenant", allowed_member_ids=[],
        supported_models=[], model_catalog_source="manual",
    )
    assert row is None


def test_delete_returns_true():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=("c-1",)))
    assert ProviderCredentialRepository(router).delete(ctx(), credential_id="c-1") is True

def test_delete_returns_false():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert ProviderCredentialRepository(router).delete(ctx(), credential_id="x") is False


def test_list_all_returns_rows():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_cred_row("c1"), _cred_row("c2", ref="relay2")]))
    rows = ProviderCredentialRepository(router).list_all(ctx())
    assert len(rows) == 2
    assert rows[0].supported_models[0]["model"] == "gpt-4o"

def test_list_all_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    assert ProviderCredentialRepository(router).list_all(ctx()) == []


def test_list_providers_supporting_model_filters():
    """list_providers_supporting_model 使用 jsonpath 过滤 enabled+model。"""
    router = FakeRouter()
    # c1 supports gpt-4o enabled; c2 supports gpt-4o-mini enabled (不应命中 gpt-4o)
    rows = [
        _cred_row("c1", models=[{"model": "gpt-4o", "enabled": True}]),
        _cred_row("c2", ref="r2", models=[{"model": "gpt-4o-mini", "enabled": True}]),
        _cred_row("c3", ref="r3", models=[{"model": "gpt-4o", "enabled": False}]),
    ]
    router.queue(FakeCursor(fetchall=rows))
    hits = ProviderCredentialRepository(router).list_providers_supporting_model(ctx(), model="gpt-4o")
    # FakeRouter 不过滤，返回全部排队行；此处重点校验 SQL 构造与参数。
    assert [r.credential_id for r in hits] == ["c1", "c2", "c3"]
    sql, params = router.executed[-1]
    assert "jsonb_path_exists" in sql
    # jsonpath 第三个参数是 {"model": "gpt-4o"}
    assert params[0] == json.dumps({"model": "gpt-4o"})


# ---- _row_to_credential edge cases ----

def test_row_to_credential_null_secret():
    raw = list(_cred_row())
    raw[5] = None
    row = _row_to_credential(tuple(raw))
    assert row.encrypted_secret == b""

def test_row_to_credential_null_member_ids():
    raw = list(_cred_row())
    raw[7] = None
    row = _row_to_credential(tuple(raw))
    assert row.allowed_member_ids == []

def test_row_to_credential_null_supported_models():
    raw = list(_cred_row())
    raw[8] = None
    row = _row_to_credential(tuple(raw))
    assert row.supported_models == []

def test_row_to_credential_null_model_catalog_source():
    raw = list(_cred_row())
    raw[9] = None
    row = _row_to_credential(tuple(raw))
    assert row.model_catalog_source == "manual"

def test_row_to_credential_empty_endpoint():
    row = _row_to_credential(_cred_row(endpoint=None))
    assert row.endpoint is None


def test_dump_supported_models_ensure_ascii_false():
    """非 ASCII（如中文 display_name）应原样保留，不被 \\u 转义。"""
    out = _dump_supported_models([{"model": "m", "display_name": "中文"}])
    assert "中文" in out
    assert "\\u" not in out
