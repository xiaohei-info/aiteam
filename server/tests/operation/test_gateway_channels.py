"""LLM gateway channel management and operator-edited model capabilities."""
import json
from datetime import UTC, datetime

import httpx
import pytest
from pydantic import ValidationError

from operation_service.gateway_channels import (
    MASK,
    GatewayChannelInput,
    ModelCapabilitiesInput,
    UpstreamModelPreviewInput,
    channel_out,
    channel_payload,
    merged_capabilities,
)
from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_repository import ModelRow, ProviderRow
from operation_service.platform_provider_service import PlatformProviderService
from shared.errors import Conflict, ValidationProblem

NOW = datetime.now(UTC)
PROVIDER = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, NOW)


def _client(handler) -> NewApiAdminClient:
    return NewApiAdminClient("http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler))


def _ok(data=None, **extra) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "message": "", "data": data, **extra})


# ---- client --------------------------------------------------------------

def test_list_channels_reads_every_page():
    pages = {"1": [{"id": index} for index in range(1, 101)], "2": [{"id": 101}]}
    seen = []

    def handler(request):
        seen.append(request.url.params["p"])
        assert request.url.params["page_size"] == "100"
        return _ok({"items": pages[request.url.params["p"]], "total": 101})

    assert len(_client(handler).list_channels()) == 101
    assert seen == ["1", "2"]


def test_list_channels_rejects_malformed_payload():
    with pytest.raises(NewApiError, match="invalid channel list"):
        _client(lambda _request: _ok([])).list_channels()


def test_create_channel_rejects_duplicate_name_before_posting():
    methods = []

    def handler(request):
        methods.append(request.method)
        return _ok({"items": [{"id": 3, "name": "主渠道"}], "total": 1})

    with pytest.raises(NewApiError, match="already exists"):
        _client(handler).create_channel({"name": "主渠道", "key": "sk-upstream"})
    assert methods == ["GET"]


def test_create_channel_posts_single_mode_and_resolves_id_by_name():
    state = {"created": False}
    posted = {}

    def handler(request):
        if request.method == "POST":
            posted.update(json.loads(request.content))
            state["created"] = True
            return _ok(None)
        items = [{"id": 9, "name": "新渠道"}] if state["created"] else []
        return _ok({"items": items, "total": len(items)})

    assert _client(handler).create_channel({"name": "新渠道", "key": "sk-upstream", "type": 1}) == 9
    assert posted == {"mode": "single", "channel": {"name": "新渠道", "key": "sk-upstream", "type": 1}}


def test_create_channel_uses_id_returned_by_gateway_without_followup_list():
    methods = []

    def handler(request):
        methods.append(request.method)
        if request.method == "POST":
            return _ok({"id": 17, "name": "新渠道"})
        return _ok({"items": [], "total": 0})

    assert _client(handler).create_channel({"name": "新渠道", "key": "sk-upstream"}) == 17
    assert methods == ["GET", "POST"]


def test_update_channel_keeps_stored_key_when_blank_and_refuses_status():
    sent = {}

    def handler(request):
        if request.method == "PUT":
            sent.update(json.loads(request.content))
            return _ok({"id": 5})
        return _ok({"id": 5, "name": "c"})

    client = _client(handler)
    assert client.update_channel(5, {"name": "c", "key": ""})["id"] == 5
    assert sent == {"name": "c", "id": 5}
    with pytest.raises(NewApiError, match="status endpoint"):
        client.update_channel(5, {"status": 1})


def test_channel_status_test_and_model_preview_request_shapes():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, request.url.query.decode(), request.content))
        if request.url.path.startswith("/api/channel/test/"):
            return httpx.Response(200, json={"success": False, "message": "403 Antigravity disabled key=sk-abc", "time": 1.2})
        if "fetch_models" in request.url.path:
            return _ok([" b ", "a", "a", 3])
        return _ok(True)

    client = _client(handler)
    client.set_channel_status(4, enabled=False)
    result = client.test_channel(4, "claude-sonnet-5-5")
    assert result["ok"] is False and "sk-abc" not in result["message"]
    assert client.fetch_upstream_models(4) == ["a", "b"]
    assert client.preview_upstream_models(channel_type=14, base_url="", key="sk-new") == ["a", "b"]

    assert calls[0][:2] == ("POST", "/api/channel/4/status") and json.loads(calls[0][3]) == {"status": 2}
    assert calls[1][:3] == ("GET", "/api/channel/test/4", "model=claude-sonnet-5-5")
    assert calls[2][:2] == ("GET", "/api/channel/fetch_models/4")
    assert calls[3][:2] == ("POST", "/api/channel/fetch_models")
    assert json.loads(calls[3][3]) == {"type": 14, "base_url": "", "key": "sk-new"}


def test_test_channel_reports_success_time():
    result = _client(lambda _request: httpx.Response(200, json={"success": True, "message": "", "time": 0.8})).test_channel(2)
    assert result == {"ok": True, "seconds": 0.8, "message": ""}


# ---- schemas / mapping ---------------------------------------------------

def _channel_input(**overrides) -> GatewayChannelInput:
    values = {"name": "主渠道", "channel_type": 1, "models": ["gpt-5.6"]}
    values.update(overrides)
    return GatewayChannelInput(**values)


@pytest.mark.parametrize("url", [
    "ftp://relay.example", "https://user:pw@relay.example", "https://relay.example/v1?key=x", "https://relay.example/#a", "relay.example",
])
def test_channel_input_rejects_unsafe_base_url(url):
    with pytest.raises(ValidationError):
        _channel_input(base_url=url)


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:9300", "http://10.0.0.4", "http://[::1]", "http://localhost", "http://metadata.google.internal",
])
def test_channel_input_rejects_private_or_metadata_base_url(url):
    with pytest.raises(ValidationError, match="本机|内网|metadata|保留"):
        _channel_input(base_url=url)


def test_channel_input_normalizes_fields():
    body = _channel_input(base_url="https://relay.example/v1/", key="  ", models=[" a ", "a", "b"], test_model=" ")
    assert body.base_url == "https://relay.example/v1"
    assert body.key is None and body.test_model is None
    assert body.models == ["a", "b"]
    with pytest.raises(ValidationError):
        _channel_input(models=["a,b"])
    with pytest.raises(ValidationError):
        _channel_input(header_override={"Bad Name": "x"})
    with pytest.raises(ValidationError):
        _channel_input(model_mapping={"a": " "})


def test_channel_out_masks_sensitive_headers_and_never_has_key():
    out = channel_out({
        "id": 7, "name": "c", "type": 14, "status": 3, "key": "sk-secret", "base_url": "https://up.example",
        "models": "claude-sonnet-5-5, gpt-5.6", "model_mapping": json.dumps({"claude-sonnet-5-5": "claude-sonnet-5-5-20261001"}),
        "header_override": json.dumps({"X-Api-Key": "sk-header", "X-Region": "us"}),
        "param_override": json.dumps({"temperature": 0.2}), "priority": 5, "response_time": 820, "test_time": 1793980000,
    })
    dumped = out.model_dump()
    assert "key" not in dumped and "sk-secret" not in json.dumps(dumped) and "sk-header" not in json.dumps(dumped)
    assert out.header_override == {"X-Api-Key": MASK, "X-Region": "us"}
    assert out.status == "auto_disabled" and out.channel_type_label == "Anthropic"
    assert out.models == ["claude-sonnet-5-5", "gpt-5.6"]
    assert out.response_time_ms == 820


def test_channel_payload_keeps_masked_header_values_and_omits_blank_key():
    original = {"header_override": json.dumps({"X-Api-Key": "sk-header"})}
    payload = channel_payload(_channel_input(header_override={"X-Api-Key": MASK, "X-Region": "eu"}), original=original)
    assert json.loads(payload["header_override"]) == {"X-Api-Key": "sk-header", "X-Region": "eu"}
    assert "key" not in payload
    assert channel_payload(_channel_input(key="sk-new"))["key"] == "sk-new"
    with pytest.raises(ValueError, match="实际值"):
        channel_payload(_channel_input(header_override={"X-Api-Key": MASK}))


def test_upstream_preview_requires_key_for_unsaved_channel():
    with pytest.raises(ValidationError):
        UpstreamModelPreviewInput(channel_type=1)
    assert UpstreamModelPreviewInput(channel_id=3).channel_id == 3


def test_model_capabilities_validation():
    with pytest.raises(ValidationError, match="上下文"):
        ModelCapabilitiesInput(context_window=8000, max_tokens=16000, reasoning=False, thinking_mode="none")
    with pytest.raises(ValidationError, match="文本"):
        ModelCapabilitiesInput(reasoning=False, thinking_mode="none", input=["image"])
    with pytest.raises(ValidationError, match="档位"):
        ModelCapabilitiesInput(reasoning=True, thinking_mode="effort", thinking_levels=["off"])
    plain = ModelCapabilitiesInput(reasoning=False, thinking_mode="effort", thinking_levels=["high"])
    assert plain.thinking_mode == "none" and plain.thinking_levels == ["off"]
    ordered = ModelCapabilitiesInput(reasoning=True, thinking_mode="effort", thinking_levels=["high", "low"], input=["image", "text"])
    assert ordered.thinking_levels == ["off", "low", "high"] and ordered.input == ["text", "image"]


def test_merged_capabilities_replaces_runtime_keys_and_keeps_other_metadata():
    body = ModelCapabilitiesInput(
        context_window=200_000, max_tokens=64_000, reasoning=True, thinking_mode="effort",
        thinking_levels=["low", "high"], thinking_level_map={"high": "max"}, input=["text", "image"],
    )
    result = merged_capabilities({"family": "claude", "input_modalities": ["text"], "context_window": 1}, body)
    assert result["family"] == "claude" and "input_modalities" not in result
    assert result["context_window"] == 200_000 and result["max_tokens"] == 64_000
    assert result["thinking_levels"] == ["off", "low", "high"]
    assert result["thinking_level_map"] == {
        "off": "none", "minimal": None, "low": "low", "medium": None, "high": "max", "xhigh": None, "max": None,
    }
    cleared = merged_capabilities(result, ModelCapabilitiesInput(reasoning=False, thinking_mode="none"))
    assert "context_window" not in cleared and cleared["input"] == ["text"]


# ---- service -------------------------------------------------------------

class _Repo:
    def __init__(self):
        self.model = ModelRow("p1", "claude-sonnet-5-5", "Claude", {"family": "claude"}, "published", "discovery", 3, NOW)
        self.saved = None

    def get_provider(self, _): return PROVIDER
    def get_model(self, _p, model_id): return self.model if model_id == self.model.model_id else None
    def upsert_discovered_models(self, _p, model_ids):
        return [ModelRow("p1", model_id, "", {"thinking_levels": ["off"], "thinking_mode": "none"}, "published", "discovery", 1, NOW) for model_id in model_ids]
    def current_rate(self, *_): return None
    def list_models(self, *_args, **_kwargs): return [self.model]
    def publish_priced_models(self, _): return []

    def set_model_capabilities(self, provider_id, model_id, *, display_name, capabilities):
        self.saved = (provider_id, model_id, display_name, capabilities)
        return ModelRow(provider_id, model_id, display_name, capabilities, "published", "discovery", 3, NOW)


class _Gateway:
    def __init__(self):
        self.channels = {1: {"id": 1, "name": "主渠道", "type": 1, "status": 1, "models": "gpt-5.6",
                             "header_override": json.dumps({"Authorization": "Bearer up"})}}
        self.writes = []

    def list_channels(self): return list(self.channels.values())
    def get_channel(self, channel_id):
        if channel_id not in self.channels:
            raise NewApiError("channel not found")
        return self.channels[channel_id]

    def create_channel(self, payload):
        self.writes.append(("create", payload))
        self.channels[2] = {"id": 2, "status": 1, **payload}
        return 2

    def update_channel(self, channel_id, payload):
        self.writes.append(("update", payload))
        self.channels[channel_id] = {**self.channels[channel_id], **payload}
        return self.channels[channel_id]

    def delete_channel(self, channel_id):
        self.writes.append(("delete", channel_id))
        self.channels.pop(channel_id)

    def set_channel_status(self, channel_id, *, enabled):
        self.channels[channel_id]["status"] = 1 if enabled else 2

    def test_channel(self, _channel_id, _model=None):
        return {"ok": False, "seconds": 2.0, "message": "403 permission_error token=sk-leak"}

    def fetch_upstream_models(self, _channel_id): return ["saved-model"]
    def preview_upstream_models(self, **values):
        self.writes.append(("preview", values))
        return ["preview-model"]


class _Pricing:
    def fetch(self): return {}


def _service(gateway=None, repo=None):
    return PlatformProviderService(repo or _Repo(), gateway or _Gateway(), None, "http://relay/v1", _Pricing())


def test_service_create_requires_key_and_resyncs_model_union():
    gateway, repo = _Gateway(), _Repo()
    discovered = []
    repo.upsert_discovered_models = lambda _p, ids: discovered.append(ids) or []
    service = _service(gateway, repo)
    with pytest.raises(ValidationProblem, match="API Key"):
        service.create_channel("p1", _channel_input(name="新渠道", models=["minimax-m3"]))
    created = service.create_channel("p1", _channel_input(name="新渠道", models=["minimax-m3"], key="sk-up"))
    assert created.id == 2 and "sk-up" not in created.model_dump_json()
    assert discovered == [["gpt-5.6", "minimax-m3"]]


def test_service_update_merges_masked_header_and_maps_gateway_errors():
    gateway = _Gateway()
    service = _service(gateway)
    out = service.update_channel("p1", 1, _channel_input(header_override={"Authorization": MASK}))
    assert gateway.writes[-1][1]["header_override"] == json.dumps({"Authorization": "Bearer up"})
    assert out.header_override == {"Authorization": MASK}
    with pytest.raises(Conflict, match="LLM 网关操作失败"):
        service.update_channel("p1", 99, _channel_input())


def test_service_channel_write_survives_empty_gateway_after_delete():
    gateway = _Gateway()
    _service(gateway).delete_channel("p1", 1)
    assert gateway.channels == {}


def test_service_status_test_and_preview():
    gateway = _Gateway()
    service = _service(gateway)
    assert service.set_channel_enabled("p1", 1, enabled=False).status == "manually_disabled"
    tested = service.test_channel("p1", 1)
    assert tested.ok is False and "sk-leak" not in tested.message
    assert service.preview_upstream_models("p1", UpstreamModelPreviewInput(channel_id=1)) == ["saved-model"]
    assert service.preview_upstream_models("p1", UpstreamModelPreviewInput(channel_id=1, key="sk-new")) == ["preview-model"]
    assert gateway.writes[-1] == ("preview", {"channel_type": 1, "base_url": "", "key": "sk-new"})


def test_service_updates_model_capabilities_in_place():
    repo = _Repo()
    model = _service(repo=repo).update_model_capabilities("p1", "claude-sonnet-5-5", ModelCapabilitiesInput(
        context_window=200_000, max_tokens=64_000, reasoning=True, thinking_mode="effort", thinking_levels=["high"],
    ))
    assert model.version == 3 and model.display_name == "Claude"
    assert repo.saved[3]["family"] == "claude" and repo.saved[3]["context_window"] == 200_000
    assert repo.saved[3]["thinking_levels"] == ["off", "high"]
