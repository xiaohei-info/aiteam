"""R7：复制专家生成企业自建专家（服务层，内存替身；SQL 与事务由 PG 集成测试覆盖）。"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from manager_service.catalog_scope_reconciler import REVOKED
from manager_service.employee_bindings_repositories import (
    ConnectorBindingRow, KnowledgeBindingRow, PromptVersionRow, SkillBindingRow,
)
from manager_service.employee_config_repository import EmployeeConfigRow
from manager_service.employee_copy_service import CopyRepositories, EmployeeCopyService
from manager_service.operator_catalog import FakeOperatorCatalogClient
from manager_service.recruit_model_guard import ModelRequired, ModelUnavailable
from manager_service.schemas import RecruitModelPolicy
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, NotFound, ValidationProblem
from tests.manager._recruit_model import MODEL, PROVIDER, platform_catalog_with_model

NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)
CTX = TenantContext(tenant_id="t-a", user_id="admin-1", roles=["owner"])


def _source(**over) -> EmployeeConfigRow:
    base = dict(
        employee_id="src-1", employee_slug="writer", display_name="文案专家", persona="你是文案专家",
        model=MODEL, provider_ref=PROVIDER, thinking_level=None, timeout_seconds=300,
        tools=["web"], skills=["skill-a"], knowledge_refs=[], connector_refs=["conn-a"],
        memory_policy={"auto_retain": True}, version=7, status="active",
        platform_model_ref={"provider_id": PROVIDER, "model_id": MODEL},
        department_ids=["d-1"], role_title="编辑", source_template_id="tpl-1", source_template_version="3",
    )
    base.update(over)
    return EmployeeConfigRow(**base)


class FakeEmployees:
    def __init__(self, *rows):
        self.rows = {r.employee_id: r for r in rows}
        self.created: list[dict] = []

    def get(self, ctx, *, employee_id):
        return self.rows.get(employee_id)

    def get_by_slug(self, ctx, *, employee_slug):
        return next((r for r in self.rows.values() if r.employee_slug == employee_slug), None)

    def create(self, ctx, **kw):
        self.created.append(kw)
        row = _source(
            employee_id=f"new-{len(self.created)}", employee_slug=kw["employee_slug"],
            display_name=kw["display_name"], model=kw["model"], provider_ref=kw["provider_ref"],
            platform_model_ref=kw["platform_model_ref"], status="draft", version=1,
            source_template_id=kw.get("source_template_id"), source_template_version=None,
        )
        self.rows[row.employee_id] = row
        return row


class Recorder:
    """按调用顺序记录写入的绑定。"""

    def __init__(self, rows=()):
        self.rows = list(rows)
        self.created: list[dict] = []

    def list_all(self, ctx, *, employee_id):
        return [r for r in self.rows if r.employee_id == employee_id]

    def get_current(self, ctx, *, employee_id):
        return next((r for r in self.rows if r.employee_id == employee_id and r.is_current), None)

    def create(self, ctx, **kw):
        self.created.append(kw)


class FakeMemory:
    def __init__(self, policy=None):
        self.policy = policy

    def get(self, ctx, *, employee_id):
        return SimpleNamespace(policy=self.policy) if self.policy is not None else None


class FakeIdempotency:
    def __init__(self):
        self.receipts: dict[tuple, tuple[str, dict]] = {}

    def execute(self, ctx, *, operation, idempotency_key, request_fingerprint, effect, status_code=200):
        key = (operation, idempotency_key)
        if key in self.receipts:
            fp, payload = self.receipts[key]
            if fp != request_fingerprint:
                raise Conflict("Idempotency-Key was already used for a different request")
            return SimpleNamespace(payload=payload, replayed=True)
        payload = effect(None)
        self.receipts[key] = (request_fingerprint, payload)
        return SimpleNamespace(payload=payload, replayed=False)


class FakeAvatars:
    def __init__(self, fail=False):
        self.calls: list[tuple[str, str]] = []
        self.fail = fail

    def copy(self, ctx, *, source_id, target_id):
        self.calls.append((source_id, target_id))
        if self.fail:
            raise OSError("disk full")


class FakeConfigService:
    def get(self, ctx, *, employee_id):
        return SimpleNamespace(employee_id=employee_id)


def _prompt(**over):
    base = dict(binding_id="p1", employee_id="src-1", version=3, display_name="文案专家", persona="你是文案专家",
                model=MODEL, provider_ref=PROVIDER, thinking_level=None, tools=["web"], is_current=True,
                change_note="x", created_at=NOW)
    base.update(over)
    return PromptVersionRow(**base)


def _build(source=None, *, catalog=None, avatars=None, memory_policy=None, extra_rows=()):
    source = source or _source()
    employees = FakeEmployees(source, *extra_rows)
    prompts = Recorder([_prompt(), _prompt(binding_id="p0", version=2, is_current=False)])
    skills = Recorder([SkillBindingRow(binding_id="s1", employee_id="src-1", skill_id="skill-a", enabled=True,
                                       config={"k": 1}, created_at=NOW, updated_at=NOW)])
    knowledge = Recorder([
        KnowledgeBindingRow(binding_id="k1", employee_id="src-1", knowledge_space_id="ks-1", enabled=True,
                            config={}, created_at=NOW, updated_at=NOW),
        KnowledgeBindingRow(binding_id="k2", employee_id="src-1", knowledge_space_id="ks-old", enabled=False,
                            config={}, created_at=NOW, updated_at=NOW, revoked_at=NOW),
    ])
    connectors = Recorder([ConnectorBindingRow(binding_id="c1", employee_id="src-1", connector_id="conn-a",
                                               grant_ref="g1", enabled=True, config={}, created_at=NOW,
                                               updated_at=NOW)])
    repos = CopyRepositories(employees=employees, prompts=prompts, skills=skills, knowledge=knowledge,
                             connectors=connectors, memory=FakeMemory(memory_policy))
    operator = catalog or FakeOperatorCatalogClient()
    if catalog is None:
        operator.seed_platform_catalog(platform_catalog_with_model())
    avatars = avatars or FakeAvatars()
    svc = EmployeeCopyService(
        employees=employees, idempotency=FakeIdempotency(), repositories=lambda session: repos,
        operator=operator, avatars=avatars, config_service=FakeConfigService(),
    )
    return svc, repos, avatars


def _copy(svc, *, name="文案专家 - 副本", policy=None, key="k-1", source_id="src-1"):
    return svc.copy(CTX, source_id=source_id, display_name=name, model_policy=policy, idempotency_key=key)


def test_copy_creates_custom_expert_with_provenance_and_configuration():
    svc, repos, avatars = _build(memory_policy={"auto_retain": True})
    out = _copy(svc)
    assert out.employee_id == "new-1"
    created = repos.employees.created[0]
    assert created["display_name"] == "文案专家 - 副本"
    assert created["origin"] == "copied" and created["copied_from_employee_id"] == "src-1"
    assert created["source_template_id"] is None and created["source_template_version"] is None
    assert created["persona"] == "你是文案专家" and created["role_title"] == "编辑"
    assert created["department_ids"] == ["d-1"] and created["tools"] == ["web"] and created["skills"] == ["skill-a"]
    assert created["connector_refs"] == ["conn-a"] and created["knowledge_refs"] == []
    assert created["memory_policy"] == {"auto_retain": True}
    assert created["platform_model_ref"] == {"provider_id": PROVIDER, "model_id": MODEL}
    assert created["employee_slug"] != "writer"
    assert avatars.calls == [("src-1", "new-1")]


def test_copy_carries_current_prompt_and_bindings_but_not_revoked_knowledge():
    svc, repos, _ = _build()
    _copy(svc)
    assert [p["is_current"] for p in repos.prompts.created] == [True]
    assert repos.prompts.created[0]["employee_id"] == "new-1" and repos.prompts.created[0]["display_name"] == "文案专家 - 副本"
    assert [(s["skill_id"], s["config"]) for s in repos.skills.created] == [("skill-a", {"k": 1})]
    assert [k["knowledge_space_id"] for k in repos.knowledge.created] == ["ks-1"]
    assert [(c["connector_id"], c["grant_ref"]) for c in repos.connectors.created] == [("conn-a", "g1")]
    assert all(r["employee_id"] == "new-1" for r in repos.skills.created + repos.knowledge.created + repos.connectors.created)


def test_copy_slug_is_unique_in_tenant():
    taken = _source(employee_id="x", employee_slug="copy_name")
    svc, repos, _ = _build(extra_rows=(taken,))
    _copy(svc, name="Copy Name")
    assert repos.employees.created[0]["employee_slug"] == "copy_name_1"


def test_copy_uses_source_model_when_present_and_override_when_given():
    svc, repos, _ = _build()
    other = platform_catalog_with_model()
    other["models"].append({"model": {"provider_id": PROVIDER, "model_id": "m2", "status": "published", "capabilities": {}},
                            "rate": {"pricing_status": "known"}})
    svc._operator.seed_platform_catalog(other)
    _copy(svc, policy=RecruitModelPolicy(provider_ref=PROVIDER, model="m2"))
    assert repos.employees.created[0]["model"] == "m2"
    assert repos.employees.created[0]["platform_model_ref"] == {"provider_id": PROVIDER, "model_id": "m2"}


def test_copy_without_any_model_is_422_and_writes_nothing():
    svc, repos, avatars = _build(_source(model=None, provider_ref=None, platform_model_ref=None))
    with pytest.raises(ModelRequired):
        _copy(svc)
    assert repos.employees.created == [] and avatars.calls == []


def test_copy_with_unavailable_source_model_is_422_until_replaced():
    catalog = FakeOperatorCatalogClient()
    data = platform_catalog_with_model()
    data["models"][0]["model"]["status"] = "hidden"
    catalog.seed_platform_catalog(data)
    svc, repos, _ = _build(catalog=catalog)
    with pytest.raises(ModelUnavailable):
        _copy(svc)
    assert repos.employees.created == []


def test_copy_blocked_when_source_is_out_of_scope():
    svc, repos, _ = _build(_source(status="paused", status_reason=REVOKED))
    with pytest.raises(Conflict) as exc:
        _copy(svc)
    assert exc.value.code == "template_out_of_scope"
    assert repos.employees.created == []


def test_copy_missing_source_is_not_found():
    svc, _, _ = _build()
    with pytest.raises(NotFound):
        _copy(svc, source_id="nope")


def test_copy_requires_idempotency_key_and_replays_same_result():
    svc, repos, avatars = _build()
    with pytest.raises(ValidationProblem):
        _copy(svc, key="  ")
    first = _copy(svc, key="same")
    again = _copy(svc, key="same")
    assert first.employee_id == again.employee_id == "new-1"
    assert len(repos.employees.created) == 1 and avatars.calls == [("src-1", "new-1")]
    with pytest.raises(Conflict):
        _copy(svc, key="same", name="另一个名字")


def test_avatar_failure_does_not_fail_the_copy():
    svc, repos, _ = _build(avatars=FakeAvatars(fail=True))
    assert _copy(svc).employee_id == "new-1"
    assert len(repos.employees.created) == 1


def test_copy_name_is_trimmed_and_required():
    svc, repos, _ = _build()
    _copy(svc, name="  新专家  ")
    assert repos.employees.created[0]["display_name"] == "新专家"
    with pytest.raises(ValidationProblem):
        _copy(svc, name="   ", key="k-2")
