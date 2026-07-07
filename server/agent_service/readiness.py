"""M5 专家/runtime readiness 聚合（AITEAM-693）。

把部署级 runtime 就绪、单个专家的 skills/knowledge/memory/provider 装配就绪聚合成一份
``ReadinessReport``，供前端在「专家列表 / 会话页」展示可用性并在不满足时阻断 + 提示原因。

数据来源（M0/M2/M3/M4 已实现，本模块只做聚合，不重复探测）：
- runtime：复用 ``agent_gateway.runtime_readiness.check_runtime_readiness``（M0）。
- provider 凭据：复用 ``agent_gateway.provider_resolver.is_provider_configured``（M4）。
- skills：复用 ``SkillCache.exists/local``（M2 持久缓存）。
- knowledge / memory / connector：复 CapabilityRegistry + ``check_capability_health``（M3）。
  registry 可选——未注入时把这些能力标为 unknown（不阻断），意为 M3 registry 尚未在本端部署配通。

阻断语义（对齐设计）：
- runtime 未配置 / CLI 不可用 → 阻断。
- provider 未知引用或凭据缺失 → 阻断。
- knowledge 不可用 → 阻断。
- memory 不可用 → 降级（不阻断，仅提示）。
- connector 不可用 → 阻断。
- skill 未投影到本地缓存 → 阻断并提示具体缺失 skill。
"""

from __future__ import annotations

import dataclasses
from typing import Literal

from agent_gateway.provider_resolver import is_provider_configured
from agent_gateway.runtime_readiness import check_runtime_readiness

from agent_service.capabilities.health import HealthStatus, check_capability_health
from agent_service.capabilities.registry import CapabilityKind, CapabilityRegistry

from .grants.service import GrantsService

Readyness = Literal["ready", "degraded", "blocked", "unknown"]


@dataclasses.dataclass
class SkillReadiness:
    """单个 skill 的就绪状态。"""

    ref: str
    status: Readyness
    reason: str | None = None
    version: str | None = None


@dataclasses.dataclass
class CapabilityReadiness:
    """一类能力（knowledge/memory/connector）的就绪状态。"""

    kind: str
    refs: list[str]
    status: Readyness
    reason: str | None = None


@dataclasses.dataclass
class ExpertReadiness:
    """单个专家的运行就绪状态。"""

    employee_id: str
    display_name: str
    handle: str
    available: bool
    runtime: Readyness
    provider: Readyness
    skills: list[SkillReadiness]
    capabilities: list[CapabilityReadiness]
    reasons: list[str]


@dataclasses.dataclass
class ReadinessReport:
    """整端 readiness：部署级 runtime + 每个已装载专家的可用性。"""

    runtime: Readyness
    runtime_reason: str | None
    experts: list[ExpertReadiness]


def _provider_readiness(provider_ref: str | None) -> tuple[Readyness, str | None]:
    if is_provider_configured(provider_ref):
        return "ready", None
    if not provider_ref:
        return "degraded", "未配置 provider_ref（将使用 runtime 默认 provider）"
    return "blocked", f"provider_ref={provider_ref!r} 未配置或凭据缺失"


def _capability_readiness(
    kind: str,
    refs: list[str],
    *,
    registry: CapabilityRegistry | None,
    blocking: bool,
) -> CapabilityReadiness:
    """按 kind 计算一类能力的就绪。

    blocking=True（knowledge/connector）→ not_ready 视为 blocked；
    blocking=False（memory）→ not_ready 视为 degraded。
    registry 未注入时：有 refs 标 unknown，无 refs 标 ready。
    """
    if not refs:
        return CapabilityReadiness(kind=kind, refs=[], status="ready", reason=None)
    kind_enum = CapabilityKind(kind)
    if registry is None:
        return CapabilityReadiness(
            kind=kind, refs=list(refs), status="unknown",
            reason="本端未装配 CapabilityRegistry，无法校验该能力是否就绪",
        )
    bad: list[str] = []
    for ref in refs:
        entry = registry.lookup(kind_enum, ref)
        if entry is None:
            bad.append(f"{ref}(无 registry 条目)")
            continue
        health = check_capability_health(entry, ref=ref)
        if health.status != HealthStatus.READY:
            bad.append(f"{ref}({health.reason or 'not_ready'})")
    if not bad:
        return CapabilityReadiness(kind=kind, refs=list(refs), status="ready", reason=None)
    status: Readyness = "blocked" if blocking else "degraded"
    return CapabilityReadiness(
        kind=kind, refs=list(refs), status=status, reason="; ".join(bad),
    )


class ReadinessService:
    """聚合 readiness。构造后无状态，可跨请求复用。"""

    def __init__(
        self,
        *,
        grants: GrantsService,
        runtime_selection: str | None,
        production: bool,
        capability_registry: CapabilityRegistry | None = None,
    ) -> None:
        self._grants = grants
        self._runtime_selection = runtime_selection
        self._production = production
        self._registry = capability_registry

    # ---- 整端报告 ----

    def build_report(self) -> ReadinessReport:
        runtime_rr = check_runtime_readiness(self._runtime_selection, production=self._production)
        runtime_status: Readyness = "ready" if runtime_rr.status == "ready" else "blocked"
        experts: list[ExpertReadiness] = []
        for proj in self._grants.available_experts():
            experts.append(self._expert_readiness(proj.employee_id))
        return ReadinessReport(
            runtime=runtime_status,
            runtime_reason=runtime_rr.reason,
            experts=experts,
        )

    def expert(self, employee_id: str) -> ExpertReadiness:
        return self._expert_readiness(employee_id)

    # ---- 内部 ----

    def _expert_readiness(self, employee_id: str) -> ExpertReadiness:
        projection = self._grants._projections.get(employee_id)
        if projection is None:
            return ExpertReadiness(
                employee_id=employee_id, display_name="", handle="", available=False,
                runtime="blocked", provider="blocked", skills=[], capabilities=[],
                reasons=["专家本地投影不存在（未装载或未授权）"],
            )
        # 绑定最新已冻结快照（用于 skills/knowledge/memory/connector refs）。
        snapshot = self._grants.latest_snapshot(employee_id)
        if snapshot is None:
            return ExpertReadiness(
                employee_id=employee_id,
                display_name=projection.display_name,
                handle=projection.handle or projection.display_name,
                available=False,
                runtime="blocked", provider="blocked", skills=[], capabilities=[],
                reasons=[f"专家 {projection.display_name or employee_id} 没有已冻结快照（Manager 未拉取/未装载）"],
            )

        reasons: list[str] = []

        runtime_rr = check_runtime_readiness(self._runtime_selection, production=self._production)
        runtime_status: Readyness = "ready" if runtime_rr.status == "ready" else "blocked"
        if runtime_rr.reason:
            reasons.append(f"runtime: {runtime_rr.reason}")

        provider_status, provider_reason = _provider_readiness(
            snapshot.model_policy.provider_ref or projection.model_policy.provider_ref
        )
        if provider_status != "ready" and provider_reason:
            reasons.append(f"provider: {provider_reason}")

        skills = self._skills_readiness(snapshot.skills or projection.skills)
        for s in skills:
            if s.status == "blocked" and s.reason:
                reasons.append(f"skill: {s.reason}")

        capabilities = [
            _capability_readiness(
                "knowledge", snapshot.knowledge_refs or projection.knowledge_refs,
                registry=self._registry, blocking=True,
            ),
            _capability_readiness(
                "memory", _memory_refs(snapshot.memory_policy or projection.memory_policy),
                registry=self._registry, blocking=False,
            ),
            _capability_readiness(
                "connector", snapshot.connector_refs or projection.connector_refs,
                registry=self._registry, blocking=True,
            ),
        ]
        for c in capabilities:
            if c.status == "blocked" and c.reason:
                reasons.append(f"{c.kind}: {c.reason}")
            elif c.status == "unknown" and c.reason:
                # unknown 仅提示，不阻断。
                reasons.append(f"{c.kind}: {c.reason}")

        blocked_still = (
            runtime_status == "blocked"
            or provider_status == "blocked"
            or any(s.status == "blocked" for s in skills)
            or any(c.status == "blocked" for c in capabilities)
        )
        return ExpertReadiness(
            employee_id=employee_id,
            display_name=projection.display_name,
            handle=projection.handle or projection.display_name,
            available=not blocked_still,
            runtime=runtime_status,
            provider=provider_status,
            skills=skills,
            capabilities=capabilities,
            reasons=reasons,
        )

    def _skills_readiness(self, refs: list[str]) -> list[SkillReadiness]:
        out: list[SkillReadiness] = []
        cache = getattr(self._grants, "_skills", None)
        # cache 为 SkillsService（持有 SkillCache）；取其底层 cache 判断已投影。
        skill_cache: object | None = getattr(cache, "cache", None) if cache is not None else None
        for ref in refs:
            pkg = skill_cache.get_latest(ref) if skill_cache is not None else None
            if pkg is not None:
                out.append(SkillReadiness(ref=ref, status="ready", version=pkg.version or None))
            else:
                out.append(SkillReadiness(
                    ref=ref, status="blocked",
                    reason=f"skill {ref!r} 尚未同步到本地（未授权或 sync 未完成）",
                ))
        return out


def _memory_refs(memory_policy: dict | None) -> list[str]:
    if not memory_policy:
        return []
    # memory_policy 可能含 engine/ref 等字段；取字符串引用列表。
    refs: list[str] = []
    for key in ("ref", "engine", "backend"):
        v = memory_policy.get(key)
        if isinstance(v, str) and v:
            refs.append(v)
    return refs


# ---- JSON 序列化（供路由层直接 model_dump） ----

def _skill_to_dict(s: SkillReadiness) -> dict:
    return {"ref": s.ref, "status": s.status,
            **({"reason": s.reason} if s.reason else {}),
            **({"version": s.version} if s.version else {})}


def _cap_to_dict(c: CapabilityReadiness) -> dict:
    return {"kind": c.kind, "refs": c.refs, "status": c.status,
            **({"reason": c.reason} if c.reason else {})}


def expert_to_dict(e: ExpertReadiness) -> dict:
    return {
        "employee_id": e.employee_id,
        "display_name": e.display_name,
        "handle": e.handle,
        "available": e.available,
        "runtime": e.runtime,
        "provider": e.provider,
        "skills": [_skill_to_dict(s) for s in e.skills],
        "capabilities": [_cap_to_dict(c) for c in e.capabilities],
        "reasons": e.reasons,
    }


def report_to_dict(rep: ReadinessReport) -> dict:
    return {
        "runtime": rep.runtime,
        **({"runtime_reason": rep.runtime_reason} if rep.runtime_reason else {}),
        "experts": [expert_to_dict(e) for e in rep.experts],
    }
