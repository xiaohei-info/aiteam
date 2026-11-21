"""企业端「让模型帮我找」（设计 2026-11-20 §4.5，P4）：三种 Relay 协议、有界循环、编造链接丢弃、用量计入 owner。"""
from __future__ import annotations

import json
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient

from manager_service.capability_assist import (
    MAX_ROUNDS,
    MAX_TOOL_CALLS,
    AssistModelUnavailable,
    AssistRequest,
    CapabilityAssistService,
)
from manager_service.skill_import_service import SkillImportService
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import (
    AppError,
    Forbidden,
    NotFound,
    ServiceUnavailable,
    TooManyRequests,
    Unauthorized,
)
from shared.mcp_probe import McpProbeResult
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager.test_capability_catalog import _FakeRepo
from tests.manager.test_skill_import import _Audit, _Fetch

RELAY = "https://relay.example.com/v1"
TOKEN = "relay-token-for-tenant"
SKILL_URL = "https://clawhub.example.com/alice/skills/weekly-report"
RAW_SKILL = "https://docs.example.com/SKILL.md"
SECRET = "config-secret-value-123"


class _Operator:
    def __init__(self, protocol="openai-completions", rate=None, allowed=("gpt-x",)):
        self.protocol = protocol
        self.rate = rate if rate is not None else {
            "pricing_version": 3, "pricing_status": "known", "billing_mode": "token",
            "input_usd_per_million": "2", "output_usd_per_million": "8", "cache_read_usd_per_million": "0.5",
            "currency": "USD", "effective_from": "2026-11-01T00:00:00Z",
        }
        self.allowed = list(allowed)
        self.resolved: list[dict] = []

    def list_platform_catalog(self, tenant_id=None):
        return {"providers": [], "models": [{"model": {"provider_id": "p1", "model_id": "gpt-x", "status": "published"}, "rate": self.rate}]}

    def resolve_tenant_access(self, *, tenant_id, provider_id, model_ids):
        self.resolved.append({"tenant_id": tenant_id, "provider_id": provider_id, "model_ids": model_ids})
        return {"access": {"allowed_model_ids": self.allowed, "version": 1}, "relay_base_url": RELAY,
                "api_protocol": self.protocol, "relay_token": TOKEN}


class _Relay:
    """Scripted model: each call pops the next response body; records requests."""

    def __init__(self, responses: list[dict], status: int = 200):
        self.responses = list(responses)
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": "no"})
        return httpx.Response(200, json=self.responses.pop(0))

    def bodies(self) -> list[dict]:
        return [json.loads(item.content) for item in self.requests]


# ---- scripted turns per protocol ----

def chat(calls=(), text="", tokens=(100, 20, 0)):
    message = {"role": "assistant", "content": text or None}
    if calls:
        message["tool_calls"] = [{"id": f"c{index}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                                 for index, (name, args) in enumerate(calls)]
    return {"choices": [{"message": message}], "usage": {"prompt_tokens": tokens[0], "completion_tokens": tokens[1],
                                                         "prompt_tokens_details": {"cached_tokens": tokens[2]}}}


def responses(calls=(), text="", tokens=(100, 20)):
    output = [{"type": "function_call", "call_id": f"c{index}", "name": name, "arguments": json.dumps(args)} for index, (name, args) in enumerate(calls)]
    if text:
        output.append({"type": "message", "content": [{"type": "output_text", "text": text}]})
    return {"output": output, "usage": {"input_tokens": tokens[0], "output_tokens": tokens[1]}}


def anthropic(calls=(), text="", tokens=(100, 20)):
    content = ([{"type": "text", "text": text}] if text else []) + [
        {"type": "tool_use", "id": f"c{index}", "name": name, "input": args} for index, (name, args) in enumerate(calls)]
    return {"content": content, "usage": {"input_tokens": tokens[0], "output_tokens": tokens[1]}}


PROPOSAL = ("propose", {"candidates": [
    {"kind": "skill", "source": "clawhub", "title": "周报", "summary": "把一周工作整理成周报", "reason": "正好是周报", "url": SKILL_URL},
    {"kind": "skill", "source": "github", "title": "编造的", "url": "https://github.com/made/up"},
], "notes": "找到一个"})


def _clawhub_search() -> bytes:
    return json.dumps({"results": [{"slug": "weekly-report", "description": "周报技能", "downloads": 120,
                                    "install": {"reference": "alice/weekly-report"}}]}).encode()


class _Preview:
    """Read-only preview stand-in that records what it was asked to inspect."""

    def __init__(self):
        self.asked: list[tuple[str, str]] = []

    def preview(self, ctx, request):
        self.asked.append((request.source, request.url))
        return {"origin": {"kind": request.source, "label": "x"}, "clawhub": {"owner": "alice", "slug": "weekly-report", "security": {
            "status": "suspicious", "has_warnings": True, "scanners": []}},
            "preview": {"root": "", "ok": True, "name": "weekly-report", "description": "周报", "version": "1.0.0",
                        "file_count": 3, "skipped": []}}


def _ctx(roles=("enterprise_admin",)):
    return TenantContext(tenant_id="t-a", user_id="admin-1", roles=list(roles))


def _service(relay: _Relay, *, operator=None, fetch=None, import_service=None, probe=None):
    usage: list[dict] = []
    audit = _Audit()
    service = CapabilityAssistService(
        operator=operator or _Operator(), import_service=import_service or _Preview(),
        usage_sink=lambda ctx, payload: usage.append(payload), owner_lookup=lambda ctx: "owner-1", audit=audit,
        http=httpx.Client(transport=httpx.MockTransport(relay)),
        fetch=fetch or _Fetch({"https://clawhub.example.com/api/v1/search?q=%E5%91%A8%E6%8A%A5&limit=8": (200, {}, _clawhub_search())}),
        probe=probe or (lambda request: McpProbeResult(status="ok", auth="none", tools=["find_order"], server_name="ERP")),
        clawhub_base="https://clawhub.example.com", github_base="https://api.github.example.com",
    )
    return service, usage, audit


def _request(**kw):
    return AssistRequest(requirement=kw.pop("requirement", "我们想让员工能写周报"), provider_id="p1", model_id="gpt-x", **kw)


def test_chat_completions_finds_verifies_and_drops_made_up_links():
    relay = _Relay([
        chat([("search_clawhub", {"query": "周报"})]),
        chat([("inspect_link", {"url": SKILL_URL})], tokens=(300, 30, 100)),
        chat([PROPOSAL], tokens=(400, 50, 0)),
    ])
    service, usage, audit = _service(relay)
    out = service.run(_ctx(), _request())

    assert [item["url"] for item in out["candidates"]] == [SKILL_URL]
    assert out["dropped"] == 1 and out["incomplete"] is False and out["notes"] == "找到一个"
    first = out["candidates"][0]
    assert first["verified"] is True and first["security"]["status"] == "suspicious"
    assert (out["rounds"], out["tool_calls"]) == (3, 2)
    # Relay: Agent-compatible path, tenant token, tools offered, bounded output.
    assert [str(item.url) for item in relay.requests] == [f"{RELAY}/chat/completions"] * 3
    assert relay.requests[0].headers["authorization"] == f"Bearer {TOKEN}"
    body = relay.bodies()[0]
    assert body["model"] == "gpt-x" and body["max_tokens"] == 4096
    assert {tool["function"]["name"] for tool in body["tools"]} == {"search_clawhub", "search_github", "inspect_link", "parse_mcp_config", "propose"}
    # The second turn carries the tool result back to the model.
    assert relay.bodies()[1]["messages"][-1]["role"] == "tool" and "weekly-report" in relay.bodies()[1]["messages"][-1]["content"]
    # Usage: uncached 100+200+400, cached 100, output 20+30+50 → 2·700 + 0.5·100 + 8·100 per million.
    assert out["usage"] == {"input_tokens": 800, "output_tokens": 100, "cost": "0.002250", "pricing_status": "known"}
    [row] = usage
    assert row["summary_id"].startswith("manager-assist-") and row["member_id"] == "owner-1" and row["employee_id"] is None
    assert (row["input_tokens"], row["cache_tokens"], row["output_tokens"], row["token_total"]) == (700, 100, 100, 900)
    assert row["cost_total"] == Decimal("0.002250") and row["pricing_version"] == 3 and row["error_count"] == 0
    assert row["window_end"] - row["window_start"] == __import__("datetime").timedelta(hours=1)
    # Nothing the admin or the model wrote is recorded.
    assert "周报" not in json.dumps(row, default=str)
    [event] = audit.events
    assert event["action"] == "capability_assist.invoked" and event["actor"] == "admin-1" and event["resource_id"] == "p1/gpt-x"
    assert "周报" not in event["detail"]


def test_responses_protocol_round_trip():
    relay = _Relay([responses([("search_clawhub", {"query": "周报"})]), responses([PROPOSAL])])
    service, _, _ = _service(relay, operator=_Operator(protocol="openai-responses"))
    out = service.run(_ctx(), _request())
    assert [item["url"] for item in out["candidates"]] == [SKILL_URL] and out["candidates"][0]["verified"] is False
    assert [str(item.url) for item in relay.requests] == [f"{RELAY}/responses"] * 2
    second = relay.bodies()[1]
    assert second["store"] is False and second["max_output_tokens"] == 4096
    assert [item.get("type") for item in second["input"][1:]] == ["function_call", "function_call_output"]


def test_anthropic_protocol_round_trip():
    relay = _Relay([anthropic([("search_clawhub", {"query": "周报"})], text="先搜一下"), anthropic([PROPOSAL])])
    service, _, _ = _service(relay, operator=_Operator(protocol="anthropic-messages"))
    out = service.run(_ctx(), _request())
    assert [item["url"] for item in out["candidates"]] == [SKILL_URL]
    # Same URL the member Agent's Anthropic SDK builds from a /v1 base.
    assert [str(item.url) for item in relay.requests] == [f"{RELAY}/v1/messages"] * 2
    assert relay.requests[0].headers["x-api-key"] == TOKEN and relay.requests[0].headers["anthropic-version"]
    second = relay.bodies()[1]
    assert second["messages"][1]["role"] == "assistant"
    assert second["messages"][2]["content"][0]["type"] == "tool_result"


def test_bounds_stop_a_model_that_never_proposes():
    endless = [chat([("search_github", {"query": "x"})] * 3) for _ in range(MAX_ROUNDS + 2)]
    relay = _Relay(endless)
    fetch = _Fetch({})
    service, usage, _ = _service(relay, fetch=fetch)
    out = service.run(_ctx(), _request())
    assert out["rounds"] == MAX_ROUNDS and out["incomplete"] is True and out["candidates"] == []
    assert out["tool_calls"] == MAX_TOOL_CALLS and len(fetch.seen) == MAX_TOOL_CALLS
    # Calls over budget are answered with an instruction to finish, not executed.
    last_results = [item["content"] for item in relay.bodies()[-1]["messages"] if item["role"] == "tool"][-3:]
    assert all("propose" in item for item in last_results)
    assert len(usage) == 1


def test_admin_config_is_parsed_server_side_and_its_token_never_reaches_the_model():
    config = json.dumps({"mcpServers": {"erp": {"url": "https://erp.example.com/mcp", "headers": {"X-API-Key": SECRET}}}})
    relay = _Relay([chat([("propose", {"candidates": [
        {"kind": "mcp", "source": "config", "title": "ERP", "url": "https://erp.example.com/mcp"}]})])])
    service, _, _ = _service(relay)
    out = service.run(_ctx(), _request(config_json=config))
    assert [item["url"] for item in out["candidates"]] == ["https://erp.example.com/mcp"]
    sent = relay.requests[0].content.decode()
    assert SECRET not in sent and "X-API-Key" in json.loads(sent)["messages"][1]["content"]


def test_admin_link_counts_as_a_source_and_mcp_links_are_probed():
    relay = _Relay([
        chat([("inspect_link", {"url": "https://erp.example.com/mcp"})]),
        chat([("propose", {"candidates": [{"kind": "mcp", "source": "url", "title": "ERP", "url": "https://erp.example.com/mcp/"}]})]),
    ])

    class _NotSkill(_Preview):
        def preview(self, ctx, request):
            from manager_service.skill_import_service import SkillSourceUnavailable
            raise SkillSourceUnavailable("对方返回 HTTP 405")

    probed = []
    service, _, _ = _service(relay, import_service=_NotSkill(),
                             probe=lambda request: probed.append(request.url) or McpProbeResult(status="ok", auth="oauth", tools=[]))
    out = service.run(_ctx(), _request(link="https://erp.example.com/mcp"))
    assert probed == ["https://erp.example.com/mcp"]
    assert out["candidates"][0]["kind"] == "mcp" and out["candidates"][0]["verified"] is True
    assert '"auth": "oauth"' in relay.bodies()[1]["messages"][-1]["content"]


def test_inspect_link_uses_the_real_read_only_import_preview():
    relay = _Relay([chat([("inspect_link", {"url": RAW_SKILL})]), chat([("propose", {"candidates": []}), ], text="")])
    skill = b"---\nname: meeting-notes\ndescription: \xe4\xbc\x9a\xe8\xae\xae\xe7\xba\xaa\xe8\xa6\x81\nversion: 2.1.0\n---\n# notes\n"
    repo = _FakeRepo()
    importer = SkillImportService(repo, fetch=_Fetch({RAW_SKILL: (200, {"content-type": "text/markdown"}, skill)}),
                                  clawhub_base="https://clawhub.example.com")
    service, _, _ = _service(relay, import_service=importer)
    service.run(_ctx(), _request())
    result = json.loads(relay.bodies()[1]["messages"][-1]["content"])
    assert result["kind"] == "skill" and result["skills"][0]["name"] == "meeting-notes" and result["skills"][0]["version"] == "2.1.0"
    assert result["skills"][0]["importable"] is True
    assert repo.list_skills(_ctx()) == []  # preview never writes


def test_relay_failure_before_any_answer_is_a_502_and_is_still_recorded():
    relay = _Relay([], status=401)
    service, usage, audit = _service(relay)
    with pytest.raises(AssistModelUnavailable, match="拒绝"):
        service.run(_ctx(), _request())
    [row] = usage
    # Known price, nothing consumed: a real zero, not an unknown.
    assert row["error_count"] == 1 and row["token_total"] == 0 and row["pricing_status"] == "known" and row["cost_total"] == Decimal(0)
    assert audit.events[0]["detail"].endswith("failed")


def test_relay_failure_mid_way_returns_what_was_found():
    relay = _Relay([chat([("search_clawhub", {"query": "周报"})])])
    relay_calls = {"n": 0}
    original = relay.__call__

    def flaky(request):
        relay_calls["n"] += 1
        return original(request) if relay_calls["n"] == 1 else httpx.Response(500)

    service, usage, _ = _service(relay)
    service._http = httpx.Client(transport=httpx.MockTransport(flaky))
    out = service.run(_ctx(), _request())
    assert out["incomplete"] is True and out["error"] == "模型服务返回 HTTP 500" and out["rounds"] == 1
    assert usage[0]["error_count"] == 1 and usage[0]["output_tokens"] == 20


def test_unknown_price_records_tokens_without_a_cost():
    relay = _Relay([chat([PROPOSAL])])
    service, usage, _ = _service(relay, operator=_Operator(rate={"pricing_status": "unknown"}))
    out = service.run(_ctx(), _request())
    assert out["usage"]["pricing_status"] == "unknown" and out["usage"]["cost"] is None
    assert usage[0]["cost_total"] is None and usage[0]["pricing_version"] is None and usage[0]["token_total"] == 120


def test_only_admins_and_only_this_enterprises_models():
    relay = _Relay([])
    service, usage, _ = _service(relay)
    with pytest.raises(Forbidden):
        service.run(_ctx(roles=("member",)), _request())
    with pytest.raises(NotFound):
        service.run(_ctx(), AssistRequest(requirement="x", provider_id="p1", model_id="other"))
    restricted, _, _ = _service(relay, operator=_Operator(allowed=("someone-else",)))
    with pytest.raises(NotFound):
        restricted.run(_ctx(), _request())
    assert relay.requests == [] and usage == []


def test_resolve_passes_only_the_chosen_model_so_the_tenant_token_is_not_narrowed():
    operator = _Operator()
    service, _, _ = _service(_Relay([chat([PROPOSAL])]), operator=operator)
    service.run(_ctx(), _request())
    # Operation unions the requested model with the tenant's existing allowed set (platform_provider_service).
    assert operator.resolved == [{"tenant_id": "t-a", "provider_id": "p1", "model_ids": ["gpt-x"]}]


class _BrokenOperator(_Operator):
    def __init__(self, error: Exception, *, on: str):
        super().__init__()
        self.error, self.on = error, on

    def list_platform_catalog(self, tenant_id=None):
        if self.on == "catalog":
            raise self.error
        return super().list_platform_catalog(tenant_id)

    def resolve_tenant_access(self, **kwargs):
        if self.on == "resolve":
            raise self.error
        return super().resolve_tenant_access(**kwargs)


@pytest.mark.parametrize("on", ["catalog", "resolve"])
@pytest.mark.parametrize(("error", "expected"), [
    (AppError("upstream 502"), ServiceUnavailable),  # Operation 5xx / proxy → generic AppError(500) from service_client
    (Unauthorized("bad service identity"), ServiceUnavailable),  # must not reach the admin as 401 (would log them out)
    (httpx.ConnectError("refused"), ServiceUnavailable),
    (NotFound("gone"), NotFound),
    (TooManyRequests("slow down"), TooManyRequests),
])
def test_operation_failures_map_to_clear_admin_errors(on, error, expected):
    relay = _Relay([])
    service, usage, _ = _service(relay, operator=_BrokenOperator(error, on=on))
    with pytest.raises(expected) as caught:
        service.run(_ctx(), _request())
    if expected is ServiceUnavailable:
        assert caught.value.status == 503 and "运营端暂时不可用" in str(caught.value)
    if expected is NotFound:
        assert "本企业没有这个模型" in str(caught.value)
    assert relay.requests == [] and usage == []


# ---- route ----

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()


def _client(service):
    from manager_service.app import router as manager_router
    from manager_service.routes_capability_assist import build_capability_assist_router
    from shared.app_factory import create_app

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://unused"), manager_router)
    app.state._token_verifier = _VERIFIER
    app.state._capability_assist_service = service
    app.include_router(build_capability_assist_router(_VERIFIER))
    return TestClient(app)


def _hdr(roles=("owner",)):
    return {"Authorization": "Bearer " + sign_inmem_token(_SIGNER, "t1", list(roles))}


def test_route_returns_candidates_and_enforces_roles_and_shape():
    service, _, _ = _service(_Relay([chat([("search_clawhub", {"query": "周报"})]), chat([PROPOSAL])]))
    client = _client(service)
    body = {"requirement": "我们想让员工能写周报", "model": {"provider_id": "p1", "model_id": "gpt-x"}}
    ok = client.post("/api/manager/capability-assist", json=body, headers=_hdr())
    assert ok.status_code == 200, ok.text
    data = ok.json()["data"]
    assert data["candidates"][0]["url"] == SKILL_URL and data["usage"]["pricing_status"] == "known"
    assert client.post("/api/manager/capability-assist", json=body, headers=_hdr(("member",))).status_code == 403
    assert client.post("/api/manager/capability-assist", json={**body, "requirement": ""}, headers=_hdr()).status_code == 422
    assert client.post("/api/manager/capability-assist", json={**body, "extra": 1}, headers=_hdr()).status_code == 422


def test_assist_service_wiring_reuses_router_bills_usage_and_needs_db_and_catalog(monkeypatch):
    """`_assist_service` builds the real service from app state: one cached router, usage billed to the enterprise."""
    from types import SimpleNamespace

    import manager_service.routes_capability_assist as routes

    built: list[dict] = []
    routers: list[str] = []
    upserts: list[tuple] = []

    class _Router:
        def __init__(self, dsn):
            routers.append(dsn)

    class _Usage:
        def __init__(self, router):
            self.router = router

        def upsert_usage_with_delivery(self, ctx, *, payload, enterprise_id):
            upserts.append((ctx, payload, enterprise_id))

    monkeypatch.setattr(routes, "PgTenantRouter", _Router)
    monkeypatch.setattr(routes, "UsageAuditQuotaRepository", _Usage)
    monkeypatch.setattr(routes, "_import_service", lambda request: "import-service")
    monkeypatch.setattr(routes, "build_enterprise_audit_repository", lambda router: "audit")
    monkeypatch.setattr(routes, "_lookup_enterprise_id", lambda request, tenant_id: f"ent-{tenant_id}")
    monkeypatch.setattr(routes, "earliest_owner", lambda router, ctx: f"owner-of-{ctx}")
    monkeypatch.setattr(routes, "CapabilityAssistService", lambda **kwargs: built.append(kwargs) or kwargs)

    state = SimpleNamespace(settings=SimpleNamespace(db_url="postgresql://db"), _operator_catalog="operator")
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    first = routes._assist_service(request)
    routes._assist_service(request)
    assert routers == ["postgresql://db"]  # second call reuses the cached router
    assert (first["operator"], first["import_service"], first["audit"]) == ("operator", "import-service", "audit")
    assert first["owner_lookup"]("ctx") == "owner-of-ctx"
    first["usage_sink"](SimpleNamespace(tenant_id="t1"), {"tokens": 1})
    assert upserts[0][1:] == ({"tokens": 1}, "ent-t1")

    state._capability_assist_service = "injected"
    assert routes._assist_service(request) == "injected"

    for missing in (SimpleNamespace(settings=SimpleNamespace(db_url=""), _operator_catalog="operator"),
                    SimpleNamespace(settings=SimpleNamespace(db_url="postgresql://db"))):
        with pytest.raises(ServiceUnavailable):
            routes._assist_service(SimpleNamespace(app=SimpleNamespace(state=missing)))
