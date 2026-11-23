"""员工能力引用（技能 / 连接器）的统一入口（设计 2026-11-22 §3.2）。

员工身上的清单（``employee.skills`` / ``employee.connector_refs``）是唯一真相源；本模块是读它的
唯一入口：给出每一项在企业目录里的状态、保存时校验新增项、反查谁在用。技能与连接器共用同一套机制。

状态语义（与 authorized_config_service 的签发条件一致）：
- ready    目录里有，且能下发
- draft    目录里有，但还没有完整技能包
- invalid  目录里有，但技能包不合法
- disabled 目录里有，但被停用
- missing  目录里没有（被删除，或从没入库）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Literal

from shared.contracts.envelope import ProblemFieldError
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

from .capability_catalog_repository import CapabilityCatalogRepository
from .schemas import CapabilityRefStatusOut

RefKind = Literal["skill", "connector"]

# 面向管理员的原因文案，不出现 skill_id / 绑定 等技术词（设计 §4）。
REASON_TEXT: dict[str, dict[str, str]] = {
    "skill": {
        "draft": "还没完成，暂时不能给员工用",
        "invalid": "内容有问题，请重新导入",
        "disabled": "已被停用",
        "missing": "已从企业技能库移除，员工现在用不了它",
    },
    "connector": {
        "draft": "还没完成，暂时不能给员工用",
        "invalid": "内容有问题，请检查配置",
        "disabled": "已被停用",
        "missing": "已从企业连接器库移除，员工现在用不了它",
    },
}


class EmployeeCapabilityUnavailable(Conflict):
    """保存时新增了不可用的技能 / 连接器；errors 里逐项给出原因。"""

    code = "employee_capability_unavailable"
    title = "Capability is unavailable"


def ref_key(ref: str) -> str:
    """员工清单里的引用可以是 ``skill_id`` 或 ``skill_id@version``，目录身份只认 skill_id。"""
    return ref.partition("@")[0]


@dataclass(frozen=True)
class CatalogSnapshot:
    """一次请求内对企业目录的只读快照，避免列员工时每人查一遍库。"""

    skills: dict[str, tuple[str, str, str, bool, str]] = field(default_factory=dict)
    connectors: dict[str, tuple[str, str]] = field(default_factory=dict)

    def skill_status(self, ref: str) -> CapabilityRefStatusOut:
        key = ref_key(ref)
        entry = self.skills.get(key)
        if entry is None:
            return _status("skill", ref, ref, "missing")
        display_name, version, binding_policy, shaped, content_hash = entry
        pinned = ref.partition("@")[2]
        if pinned and pinned != version:
            return _status("skill", ref, display_name or key, "missing")
        if binding_policy == "disabled":
            state = "disabled"
        elif shaped and content_hash:
            state = "ready"
        elif not content_hash and not shaped:
            state = "draft"
        else:
            state = "invalid"
        return _status("skill", ref, display_name or key, state)

    def connector_status(self, ref: str) -> CapabilityRefStatusOut:
        entry = self.connectors.get(ref)
        if entry is None:
            return _status("connector", ref, ref, "missing")
        display_name, grant_scope = entry
        return _status("connector", ref, display_name or ref, "disabled" if grant_scope == "disabled" else "ready")


def _status(kind: RefKind, ref: str, display_name: str, state: str) -> CapabilityRefStatusOut:
    return CapabilityRefStatusOut(
        ref=ref, display_name=display_name, status=state,
        reason=None if state == "ready" else REASON_TEXT[kind][state],
    )


class EmployeeCapabilityRefs:
    def __init__(self, catalog: CapabilityCatalogRepository):
        self._catalog = catalog

    def snapshot(self, ctx: TenantContext) -> CatalogSnapshot:
        return CatalogSnapshot(
            skills={
                row.skill_id: (row.display_name, row.version, row.binding_policy, row.package_shaped, row.content_hash)
                for row in self._catalog.list_skill_summaries(ctx)
            },
            connectors={row.connector_id: (row.display_name, row.grant_scope) for row in self._catalog.list_connectors(ctx)},
        )

    def statuses(
        self, ctx: TenantContext, skills: Iterable[str], connectors: Iterable[str], *, snapshot: CatalogSnapshot | None = None,
    ) -> tuple[list[CapabilityRefStatusOut], list[CapabilityRefStatusOut]]:
        skills, connectors = list(skills), list(connectors)
        if not skills and not connectors:
            return [], []
        view = snapshot or self.snapshot(ctx)
        return [view.skill_status(ref) for ref in skills], [view.connector_status(ref) for ref in connectors]

    def validate_additions(
        self, ctx: TenantContext, *, before_skills: Iterable[str], after_skills: Iterable[str],
        before_connectors: Iterable[str], after_connectors: Iterable[str],
    ) -> None:
        """只校验相对当前配置新增的项：存量里的悬空 / 失效项不会让员工再也存不了。"""
        old_skills = {ref_key(ref) for ref in before_skills}
        old_connectors = set(before_connectors)
        new_skills = [ref for ref in dict.fromkeys(after_skills) if ref_key(ref) not in old_skills]
        new_connectors = [ref for ref in dict.fromkeys(after_connectors) if ref not in old_connectors]
        skills, connectors = self.statuses(ctx, new_skills, new_connectors)
        errors = [
            ProblemFieldError(loc=["body", field_name, item.ref], message=f"「{item.display_name}」{item.reason}", type=item.status)
            for field_name, items in (("skills", skills), ("connector_refs", connectors))
            for item in items if item.status != "ready"
        ]
        if errors:
            raise EmployeeCapabilityUnavailable("有技能或连接器现在不能给员工用，请先处理后再保存", errors=errors)
