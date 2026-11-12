"""行业文档生成：模型配置解析（平台目录 + 内部 relay key）与资料原件存储。"""

from __future__ import annotations

import stat
from types import SimpleNamespace

import pytest

from operation_service.solution_authoring_models import (
    FAUX_ENV,
    RELAY_BASE_URL_ENV,
    RELAY_TOKEN_ENV,
    FauxModelConfigResolver,
    PlatformModelCatalog,
    PublishedModel,
    RelayModelConfigResolver,
    build_model_config_resolver,
)
from operation_service.solution_authoring_storage import SourceFileStore, SourceStorageError, sha256_hex
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import Conflict, NotFound, ServiceUnavailable, ValidationProblem
from shared.solution_authoring.runner import FauxModelConfig, ProviderModelConfig

REF = PlatformModelRef(provider_id="provider-1", model_id="model-1")
RELAY_KEY = "relay-key-for-tests-0001"
DRAFT_ID = "11111111-1111-4111-8111-111111111111"
SOURCE_ID = "22222222-2222-4222-8222-222222222222"


def _published(**overrides) -> PublishedModel:
    values = {
        "provider_code": "internal", "api_protocol": "openai-completions", "relay_base_url": "https://relay.example.invalid/v1",
        "model_id": "model-1", "capabilities": {"input": ["text", "image"], "reasoning": True, "thinking_levels": ["off", "medium"],
                                               "context_window": 200_000, "max_tokens": 8192},
        **overrides,
    }
    return PublishedModel(**values)


class _Catalog:
    def __init__(self, model: PublishedModel | None = None, error: Exception | None = None):
        self._model, self._error = model or _published(), error

    def describe_published_model(self, ref):
        if self._error:
            raise self._error
        return self._model


def _resolver(model: PublishedModel | None = None, *, token: str | None = RELAY_KEY, base_url: str | None = None, error: Exception | None = None):
    return RelayModelConfigResolver(lambda: _Catalog(model, error), relay_token=token, relay_base_url=base_url)


# ---- 平台目录适配 ----

class _Validator:
    def __init__(self, error: Exception | None = None):
        self.calls: list[tuple[str, bool]] = []
        self._error = error

    def validate_model_ref(self, ref, *, require_published=False):
        self.calls.append((ref.model_id, require_published))
        if self._error:
            raise self._error
        return ref


class _Rows:
    def __init__(self, provider=True, model=True):
        self._provider = SimpleNamespace(provider_code="internal", api_protocol="openai-completions", relay_base_url="http://stored/v1") if provider else None
        self._model = SimpleNamespace(model_id="model-1", capabilities={"input": ["text"]}) if model else None

    def get_provider(self, provider_id):
        return self._provider

    def get_model(self, provider_id, model_id):
        return self._model


def test_catalog_reuses_the_platform_published_and_priced_rule():
    validator = _Validator()
    described = PlatformModelCatalog(validator, _Rows(), "https://public.example.invalid/v1").describe_published_model(REF)
    assert validator.calls == [("model-1", True)]
    assert (described.provider_code, described.api_protocol, described.model_id) == ("internal", "openai-completions", "model-1")
    assert described.relay_base_url == "https://public.example.invalid/v1" and described.capabilities == {"input": ["text"]}
    assert PlatformModelCatalog(validator, _Rows()).describe_published_model(REF).relay_base_url == "http://stored/v1"


def test_catalog_propagates_unpublished_and_missing():
    with pytest.raises(Conflict):
        PlatformModelCatalog(_Validator(Conflict("platform provider/model is not published")), _Rows()).describe_published_model(REF)
    with pytest.raises(NotFound):
        PlatformModelCatalog(_Validator(), _Rows(model=False)).describe_published_model(REF)
    with pytest.raises(NotFound):
        PlatformModelCatalog(_Validator(), _Rows(provider=False)).describe_published_model(REF)


# ---- 解析 ----

def test_resolve_builds_a_worker_config_and_keeps_the_key_out_of_repr():
    config = _resolver().resolve(REF)
    assert isinstance(config, ProviderModelConfig)
    assert (config.base_url, config.api_protocol, config.model_id, config.provider_ref) == (
        "https://relay.example.invalid/v1", "openai-completions", "model-1", "internal",
    )
    assert (config.input, config.reasoning, config.thinking_level, config.context_window, config.max_tokens) == (
        ["text", "image"], True, "medium", 200_000, 8192,
    )
    assert config.supports_images and config.secrets() == [RELAY_KEY]
    assert RELAY_KEY not in repr(config) and RELAY_KEY not in str(config)
    assert config.to_job()["api_key"] == RELAY_KEY  # 只在发给子进程 stdin 的任务体里出现


def test_resolve_defaults_for_sparse_capabilities_and_base_url_override():
    sparse = _published(capabilities={"reasoning": True, "thinking_levels": ["off", "high"], "context_window": True, "max_tokens": 0})
    config = _resolver(sparse, base_url=" http://127.0.0.1:3000/v1 ").resolve(REF)
    assert isinstance(config, ProviderModelConfig)
    assert config.base_url == "http://127.0.0.1:3000/v1"
    assert (config.input, config.thinking_level, config.context_window, config.max_tokens) == (["text"], "off", None, None)
    assert not config.supports_images


def test_check_requires_image_input_only_for_vision():
    text_only = _resolver(_published(capabilities={"input": ["text"]}))
    text_only.check(REF, need_images=False)
    with pytest.raises(ValidationProblem):
        text_only.check(REF, need_images=True)
    _resolver().check(REF, need_images=True)
    with pytest.raises(Conflict):
        _resolver(error=Conflict("platform provider/model is not published")).check(REF, need_images=False)


def test_missing_credential_or_catalog_is_a_503_without_leaking_values():
    for token in (None, "", "   "):
        resolver = _resolver(token=token)
        with pytest.raises(ServiceUnavailable) as raised:
            resolver.ensure_ready()
        assert RELAY_TOKEN_ENV in str(raised.value)
        with pytest.raises(ServiceUnavailable):
            resolver.resolve(REF)

    def unconfigured():
        # 平台目录没配齐时，是目录工厂本身抛 RuntimeError（见 build_platform_model_catalog）。
        raise RuntimeError("Operator LLM gateway settings are incomplete")

    with pytest.raises(ServiceUnavailable):
        RelayModelConfigResolver(unconfigured, relay_token=RELAY_KEY).check(REF, need_images=False)
    with pytest.raises(ServiceUnavailable) as invalid:
        _resolver(_published(api_protocol="made-up-protocol", relay_base_url="")).resolve(REF)
    assert "made-up-protocol" not in str(invalid.value) and RELAY_KEY not in str(invalid.value)


def test_builder_picks_the_faux_resolver_only_outside_production(monkeypatch):
    monkeypatch.delenv(FAUX_ENV, raising=False)
    monkeypatch.setenv(RELAY_TOKEN_ENV, RELAY_KEY)
    monkeypatch.setenv(RELAY_BASE_URL_ENV, "http://127.0.0.1:3000/v1")
    relay = build_model_config_resolver(lambda: _Catalog(), production=True)
    assert isinstance(relay, RelayModelConfigResolver) and not relay.uses_faux_model
    config = relay.resolve(REF)
    assert isinstance(config, ProviderModelConfig) and config.base_url == "http://127.0.0.1:3000/v1"

    monkeypatch.setenv(FAUX_ENV, "1")
    faux = build_model_config_resolver(lambda: _Catalog(), production=False)
    assert isinstance(faux, FauxModelConfigResolver) and faux.uses_faux_model
    faux.ensure_ready()
    faux.check(REF, need_images=True)
    assert isinstance(faux.resolve(REF), FauxModelConfig)
    with pytest.raises(ValueError, match=FAUX_ENV):
        build_model_config_resolver(lambda: _Catalog(), production=True)


# ---- 资料原件存储 ----

def test_store_roundtrip_is_private_and_leaves_no_temp_file(tmp_path):
    store = SourceFileStore(tmp_path / "root")
    data = "质量手册".encode()
    key = store.put(DRAFT_ID, SOURCE_ID, data)
    assert key == f"{DRAFT_ID}/{SOURCE_ID}"
    path = store.root / key
    assert store.read(key, sha256_hex(data)) == data
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert [item.name for item in path.parent.iterdir()] == [SOURCE_ID]

    store.put(DRAFT_ID, SOURCE_ID, b"replaced")
    assert store.read(key, sha256_hex(b"replaced")) == b"replaced"


def test_store_detects_missing_and_tampered_files(tmp_path):
    store = SourceFileStore(tmp_path)
    key = store.put(DRAFT_ID, SOURCE_ID, b"original")
    with pytest.raises(SourceStorageError):
        store.read(key, sha256_hex(b"something else"))
    store.delete(key)
    store.delete(key)  # 幂等
    with pytest.raises(SourceStorageError):
        store.read(key, sha256_hex(b"original"))


@pytest.mark.parametrize("key", ["", "../etc/passwd", f"{DRAFT_ID}/../x", f"/{DRAFT_ID}/{SOURCE_ID}", f"{DRAFT_ID}/{SOURCE_ID}/x", f"{DRAFT_ID}/名称.docx"])
def test_store_rejects_keys_that_are_not_two_server_generated_uuids(tmp_path, key):
    store = SourceFileStore(tmp_path)
    with pytest.raises(SourceStorageError):
        store.read(key, "0" * 64)
    with pytest.raises(SourceStorageError):
        store.delete(key)


def test_delete_draft_removes_only_that_draft(tmp_path):
    store = SourceFileStore(tmp_path)
    other = "33333333-3333-4333-8333-333333333333"
    store.put(DRAFT_ID, SOURCE_ID, b"a")
    kept = store.put(other, SOURCE_ID, b"b")
    store.delete_draft(DRAFT_ID)
    store.delete_draft(DRAFT_ID)  # 目录已不存在：不报错
    assert not (store.root / DRAFT_ID).exists() and store.read(kept, sha256_hex(b"b")) == b"b"
    for bad in ("..", "", f"{DRAFT_ID}/..", "."):
        with pytest.raises(SourceStorageError):
            store.delete_draft(bad)
    assert store.read(kept, sha256_hex(b"b")) == b"b"
