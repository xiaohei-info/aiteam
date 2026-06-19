"""目录发布/下架/可见范围编排（05 F03，D1）。

模板真相态归 Operator：注册=草稿（不外溢），发布/下架/可见范围变更=落本端真相 +
经窄通道通知 Manager（CatalogReleaseNotify，写调用带 Idempotency-Key）。

红线（CLAUDE/AGENTS §8 / F03）：Operator 持模板真相但**不写 Manager 租户库**（只服务通知）；
不做招募（M6，归 Manager）。
"""

from __future__ import annotations

from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.errors import Conflict

from .catalog_gateway import CatalogManagerGateway
from .catalog_repository import CatalogEntry, CatalogRepository
from .catalog_schemas import (
    CatalogEntryResponse,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
    SetVisibilityRequest,
)

_INITIAL_VERSION = "1"


def _to_response(entry: CatalogEntry) -> CatalogEntryResponse:
    return CatalogEntryResponse(
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
    )


class CatalogService:
    """无状态编排器；依赖注入 repository 与 Manager 网关（对端可 mock）。"""

    def __init__(self, repo: CatalogRepository, manager: CatalogManagerGateway):
        self._repo = repo
        self._manager = manager

    # ---- 注册（草稿态，不通知 Manager）----

    def register_expert_template(
        self, req: RegisterExpertTemplateRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.create(
            CatalogEntry(
                catalog_type=CatalogType.EXPERT_TEMPLATE,
                template_id=req.template_id,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "persona": req.persona,
                    "recommended_config": req.recommended_config,
                },
            )
        )
        return _to_response(entry)

    def register_solution_template(
        self, req: RegisterSolutionTemplateRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.create(
            CatalogEntry(
                catalog_type=CatalogType.SOLUTION_TEMPLATE,
                template_id=req.solution_id,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "expert_template_ids": req.expert_template_ids,
                    "knowledge_refs": req.knowledge_refs,
                    "skill_refs": req.skill_refs,
                    "default_grants": req.default_grants,
                },
            )
        )
        return _to_response(entry)

    # ---- 生命周期：发布 / 下架 / 可见范围 ----

    def publish_template(
        self, catalog_type: CatalogType, template_id: str, req: PublishTemplateRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.get(catalog_type, template_id)
        if entry.status == CatalogStatus.PUBLISHED:
            raise Conflict(f"already published: {template_id}")
        updated = self._repo.update(
            entry, status=CatalogStatus.PUBLISHED, visible_scope=req.visible_scope
        )
        self._notify(updated, action="published")
        return _to_response(updated)

    def unpublish_template(
        self, catalog_type: CatalogType, template_id: str
    ) -> CatalogEntryResponse:
        entry = self._repo.get(catalog_type, template_id)
        if entry.status != CatalogStatus.PUBLISHED:
            raise Conflict(f"not published, cannot unpublish: {template_id}")
        updated = self._repo.update(entry, status=CatalogStatus.UNPUBLISHED)
        self._notify(updated, action="unpublished")
        return _to_response(updated)

    def set_visibility(
        self, catalog_type: CatalogType, template_id: str, req: SetVisibilityRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.get(catalog_type, template_id)
        if entry.status != CatalogStatus.PUBLISHED:
            raise Conflict(f"visibility applies to published entries only: {template_id}")
        updated = self._repo.update(entry, visible_scope=req.visible_scope)
        self._notify(updated, action="visibility_changed")
        return _to_response(updated)

    # ---- 读 ----

    def get_entry(
        self, catalog_type: CatalogType, template_id: str
    ) -> CatalogEntryResponse:
        return _to_response(self._repo.get(catalog_type, template_id))

    def list_catalog(
        self,
        *,
        catalog_type: CatalogType | None = None,
        status: CatalogStatus | None = None,
    ) -> list[CatalogEntryResponse]:
        return [_to_response(e) for e in self._repo.list(catalog_type=catalog_type, status=status)]

    # ---- 内部：窄通道通知 Manager ----

    def _notify(self, entry: CatalogEntry, *, action: str) -> None:
        """发布/下架/可见范围变更 → 通知 Manager（不写其租户库）。

        幂等键随 type/id/version/action 派生：同一次变更可安全重试去重（05 §5.1）。
        """
        self._manager.notify_catalog_release(
            CatalogReleaseNotify(
                catalog_type=entry.catalog_type.value,
                template_id=entry.template_id,
                version=entry.version,
                action=action,
                visible_scope=entry.visible_scope,
            ),
            idempotency_key=(
                f"catalog:{entry.catalog_type.value}:{entry.template_id}"
                f":{entry.version}:{action}"
            ),
        )
