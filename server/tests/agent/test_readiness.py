"""AITEAM-693 (M5) acceptance: expert/runtime readiness aggregation."""

from __future__ import annotations

import dataclasses

import pytest

import agent_gateway.drivers.base as _base_mod

from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import (
    EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy,
)

from agent_service.capabilities.registry import (
    CapabilityEntry, CapabilityKind, CapabilityRegistry, HealthCheck,
)
from agent_service.capabilities.skill_cache import SkillPackage, SkillFile
from agent_service.readiness import ReadinessService


@dataclasses.dataclass
class FakeProjections:
    _by_id: dict = dataclasses.field(default_factory=dict)

    def upsert(self, p) -> LoadedExpertProjection:
        self._by_id[p.employee_id] = p
        return p

    def get(self, employee_id: str):
        return self._by_id.get(employee_id)

    def available(self) -> list:
        return [p for p in self._by_id.values() if not p.revoked]


class FakeSkillsCache:
    def __init__(self, cached: set[str] | None = None) -> None:
        self._cached = cached or set()

    def exists(self, skill_id: str, version: str) -> bool:
        return skill_id in self._cached

    def get_latest(self, skill_id: str):
        if skill_id in self._cached:
            return SkillPackage(skill_id=skill_id, version="v1", display_name=skill_id,
                                content_hash="h",
                                files=[SkillFile(path="SKILL.md", content="# x",
                                                 content_hash="abc123")])
        return None


class FakeSkillsWrapper:
    def __init__(self, cache) -> None:
        self.cache = cache


class FakeGrants:
    def __init__(self, projections, snapshots: dict, skills_cache=None) -> None:
        self._projections = projections
        self._snapshots = snapshots
        self._skills = FakeSkillsWrapper(skills_cache)

    def available_experts(self):
        return self._projections.available()

    def latest_snapshot(self, employee_id: str):
        return self._snapshots.get(employee_id)


def _projection(emp, version="v1", skills=(), kw=(), conn=(), mem=None,
                provider="openai"):
    return LoadedExpertProjection(
        employee_id=emp, tenant_id="t1", version=version, display_name=f"E{emp}",
        handle=f"handle-{emp}",
        model_policy=ModelPolicy(model="m", provider_ref=provider, thinking_level="deep"),
        skills=list(skills), knowledge_refs=list(kw), connector_refs=list(conn),
        memory_policy=mem,
    )


def _snapshot(emp, skills=(), kw=(), conn=(), mem=None, provider="openai"):
    return EmployeeExecutionSnapshot(
        employee_id=emp, version="v1", snapshot_version=f"s-{emp}", display_name=f"E{emp}",
        persona="p",
        model_policy=ModelPolicy(model="m", provider_ref=provider, thinking_level="deep"),
        runtime_policy=RuntimePolicy(runtime_binding="hermes", timeout_seconds=120),
        skills=list(skills), knowledge_refs=list(kw), connector_refs=list(conn),
        memory_policy=mem,
    )


@pytest.fixture
def stub_cli(monkeypatch):
    """Mark only the hermes CLI available; other capability CLIs missing -> degraded/not_ready."""
    real_which = _base_mod.shutil.which

    def _which(p):
        name = p.split("/")[-1]
        if name == "hermes":
            return "/usr/local/bin/hermes"
        return None

    monkeypatch.setattr(_base_mod.shutil, "which", _which)
    monkeypatch.setattr(_base_mod.subprocess, "run",
                        lambda *a, **k: type("R", (), {"stdout": "hermes 1.0", "stderr": ""})())


def test_report_runtime_ready_dev_no_runtime(stub_cli):
    svc = ReadinessService(grants=FakeGrants(FakeProjections(), {}),
                           runtime_selection=None, production=False)
    rep = svc.build_report()
    assert rep.runtime == "ready"
    assert rep.experts == []


def test_report_runtime_blocked_production_missing_runtime(stub_cli):
    svc = ReadinessService(grants=FakeGrants(FakeProjections(), {}),
                           runtime_selection=None, production=True)
    rep = svc.build_report()
    assert rep.runtime == "blocked"
    assert rep.runtime_reason and "AGENT_RUNTIME" in rep.runtime_reason


def test_expert_blocked_without_frozen_snapshot(stub_cli):
    proj = FakeProjections()
    proj.upsert(_projection("emp-1"))
    svc = ReadinessService(grants=FakeGrants(proj, {}),
                           runtime_selection="hermes", production=False)
    e = svc.expert("emp-1")
    assert e.available is False
    assert any("快照" in r for r in e.reasons)


def test_expert_blocked_when_provider_missing(monkeypatch, stub_cli):
    """provider_ref unknown -> provider blocked -> expert unavailable."""
    proj = FakeProjections()
    proj.upsert(_projection("emp-1", provider="ghost"))
    snaps = {"emp-1": _snapshot("emp-1", provider="ghost")}
    svc = ReadinessService(grants=FakeGrants(proj, snaps),
                           runtime_selection="hermes", production=False)
    e = svc.expert("emp-1")
    assert e.provider == "blocked"
    assert e.available is False
    assert any("provider" in r and "ghost" in r for r in e.reasons)


def test_expert_blocked_when_skill_not_cached(stub_cli, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    proj = FakeProjections()
    proj.upsert(_projection("emp-1", skills=["code-review", "testing"]))
    snaps = {"emp-1": _snapshot("emp-1", skills=["code-review", "testing"])}
    svc = ReadinessService(grants=FakeGrants(proj, snaps),
                           runtime_selection="hermes", production=False)
    e = svc.expert("emp-1")
    assert e.available is False
    blocked_refs = [s.ref for s in e.skills if s.status == "blocked"]
    assert set(blocked_refs) == {"code-review", "testing"}


def test_expert_ready_when_skill_cached_and_provider_ok(stub_cli, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    proj = FakeProjections()
    proj.upsert(_projection("emp-1", skills=["code-review"]))
    snaps = {"emp-1": _snapshot("emp-1", skills=["code-review"])}
    skills = FakeSkillsCache(cached={"code-review"})
    svc = ReadinessService(grants=FakeGrants(proj, snaps, skills_cache=skills),
                           runtime_selection="hermes", production=False)
    e = svc.expert("emp-1")
    assert e.available is True
    assert all(s.status == "ready" for s in e.skills)


def test_capability_registry_knowledge_blocks_memory_degrades(stub_cli, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    proj = FakeProjections()
    proj.upsert(_projection("emp-1", kw=["kb-x"], mem={"ref": "mem0"}))
    snaps = {"emp-1": _snapshot("emp-1", kw=["kb-x"], mem={"ref": "mem0"})}
    registry = CapabilityRegistry(entries={
        (CapabilityKind.MEMORY, "mem0"): CapabilityEntry(
            name="mem0", kind=CapabilityKind.MEMORY, command="mem0",
            health_check=HealthCheck(mode="command"),
        ),
    })
    svc = ReadinessService(grants=FakeGrants(proj, snaps),
                           runtime_selection="hermes", production=False,
                           capability_registry=registry)
    e = svc.expert("emp-1")
    kinds = {c.kind: c.status for c in e.capabilities}
    assert kinds["knowledge"] == "blocked"
    assert kinds["memory"] == "degraded"
    assert e.available is False


def test_capability_unknown_when_registry_not_injected(stub_cli, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    proj = FakeProjections()
    proj.upsert(_projection("emp-1", kw=["kb-x"]))
    snaps = {"emp-1": _snapshot("emp-1", kw=["kb-x"])}
    svc = ReadinessService(grants=FakeGrants(proj, snaps),
                           runtime_selection="hermes", production=False)
    e = svc.expert("emp-1")
    kinds = {c.kind: c.status for c in e.capabilities}
    assert kinds["knowledge"] == "unknown"
    assert e.available is True


def _run_with_binding(snapshot=None):
    from agent_service.mainline.models import Run, RunStatus
    from agent_service.mainline.service import run_provenance
    run = Run(
        id="run_x", conversation_id="conv_x", status=RunStatus.SUCCEEDED,
        employee_id="emp-1", snapshot_version="snap-1", snapshot_source="frozen",
        runtime="hermes", provider_ref="openai", skill_refs=["code-review"],
    )
    return run_provenance(run, snapshot=snapshot)


def test_run_provenance_without_snapshot_has_empty_capability():
    p = _run_with_binding(snapshot=None)
    assert p["binding"]["employee_id"] == "emp-1"
    assert p["binding"]["snapshot_version"] == "snap-1"
    assert p["binding"]["skill_refs"] == ["code-review"]
    assert p["capability"]["knowledge_refs"] == []
    assert p["capability"]["model"] is None
    assert p["meta"]["status"] == "succeeded"


def test_run_provenance_with_snapshot_exposes_capabilities_no_secret():
    from shared.contracts.snapshot import (
        EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy,
    )
    snap = EmployeeExecutionSnapshot(
        employee_id="emp-1", version="v1", snapshot_version="snap-1",
        persona="x" * 200,
        model_policy=ModelPolicy(model="m", provider_ref="openai"),
        runtime_policy=RuntimePolicy(runtime_binding="hermes"),
        skills=["code-review"], knowledge_refs=["kb-backend"],
        connector_refs=["slack"], memory_policy={"ref": "mem0"},
    )
    p = _run_with_binding(snapshot=snap)
    assert p["capability"]["model"] == "m"
    assert p["capability"]["knowledge_refs"] == ["kb-backend"]
    assert p["capability"]["connector_refs"] == ["slack"]
    assert p["capability"]["memory_policy"] == {"ref": "mem0"}
    # persona truncated to 80 chars, never full text
    assert p["capability"]["persona_preview"] == "x" * 80
    # provider_ref exposed as reference only, no secret
    assert p["binding"]["provider_ref"] == "openai"
