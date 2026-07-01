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
    ExpertBinding,
)

_INITIAL_VERSION = "1"


def _to_response(entry: CatalogEntry) -> CatalogEntryResponse:
    payload = entry.payload or {}
    return CatalogEntryResponse(
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
        default_model_json=payload.get("default_model_json", {}),
        default_binding_json=payload.get("default_binding_json", {}),
        prompt_pack_json=payload.get("prompt_pack_json", {}),
        category_code=payload.get("category_code", ""),
        role_name=payload.get("role_name", ""),
        persona=payload.get("persona"),
        recommended_config=payload.get("recommended_config", {}),
        expert_bindings=payload.get("expert_bindings"),
        knowledge_refs=payload.get("knowledge_refs", []),
        skill_refs=payload.get("skill_refs", []),
        default_grants=payload.get("default_grants"),
    )


def _normalize_expert_bindings(
    bindings: list[ExpertBinding] | None,
    fallback_ids: list[str],
) -> list[ExpertBinding]:
    """归一化方案内专家绑定列表。

    优先使用显式 bindings（含排序号/启用开关）；否则从 fallback_ids 派生，按位置顺序、全部启用。
    """
    if bindings:
        return list(bindings)
    return [
        ExpertBinding(template_id=template_id, sequence_no=idx, enabled=True)
        for idx, template_id in enumerate(fallback_ids, start=1)
    ]


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
                    "default_model_json": req.default_model_json,
                    "default_binding_json": req.default_binding_json,
                    "prompt_pack_json": req.prompt_pack_json,
                    "category_code": req.category_code,
                    "role_name": req.role_name,
                },
            )
        )
        return _to_response(entry)

    def register_solution_template(
        self, req: RegisterSolutionTemplateRequest
    ) -> CatalogEntryResponse:
        bindings = _normalize_expert_bindings(req.expert_bindings, req.expert_template_ids)
        entry = self._repo.create(
            CatalogEntry(
                catalog_type=CatalogType.SOLUTION_TEMPLATE,
                template_id=req.solution_id,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "expert_template_ids": [b.template_id for b in bindings],
                    "expert_bindings": [
                        {
                            "template_id": b.template_id,
                            "sequence_no": b.sequence_no,
                            "enabled": b.enabled,
                        }
                        for b in bindings
                    ],
                    "knowledge_refs": req.knowledge_refs,
                    "skill_refs": req.skill_refs,
                    "default_grants": req.default_grants,
                    "planner_prompt": req.planner_prompt,
                    "subtask_prompt": req.subtask_prompt,
                    "aggregate_prompt": req.aggregate_prompt,
                    "default_kb_blueprint": req.default_kb_blueprint,
                    "default_skill_bundle": req.default_skill_bundle,
                    "default_collaboration_template_ref": req.default_collaboration_template_ref,
                    "tags": req.tags,
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

    def update_entry(
        self, catalog_type: CatalogType, template_id: str, changes: dict
    ) -> CatalogEntryResponse:
        """编辑目录项（部分更新）。

        将属于 CatalogEntry dataclass 的字段直接更新（如 display_name）；
        其余字段（persona/recommended_config/expert_template_ids/knowledge_refs/
        skill_refs/default_grants）合并进 payload，避免 dataclasses.replace 收到
        未定义字段抛出 TypeError → 500。

        body 中 None 值已在 routes 层经 exclude_none 排除，此处 changes 不含 None。
        """
        entry = self._repo.get(catalog_type, template_id)
        # 分离 payload 字段与 dataclass 顶层字段
        _top_fields = {'catalog_type', 'template_id', 'version', 'display_name',
                       'status', 'visible_scope', 'payload'}
        payload_updates = {k: v for k, v in changes.items() if k not in _top_fields}
        top_updates = {k: v for k, v in changes.items() if k in _top_fields}
        if payload_updates:
            new_payload = {**(entry.payload or {}), **payload_updates}
            top_updates['payload'] = new_payload
        updated = self._repo.update(entry, **top_updates)
        return _to_response(updated)

    # ---- Manager 拉取详情（F06/F07 跨端契约，05 §5.4）----

    def pull_expert_template_detail(
        self, *, template_id: str, version: str | None = None
    ):
        """F06：Manager 拉取专家模板详情（只读；Operator 持模板真相）。

        version 为 None 时返回最新已发布版本。只返回 PUBLISHED 状态的模板。
        """
        from shared.contracts.crosstier import ExpertTemplateDetail
        from shared.errors import NotFound

        entry = self._repo.get(CatalogType.EXPERT_TEMPLATE, template_id)
        if entry.status != CatalogStatus.PUBLISHED:
            raise NotFound(f"expert template not published: {template_id}")
        if version is not None and entry.version != version:
            raise NotFound(f"expert template version mismatch: {template_id}@{version}")

        payload = entry.payload or {}
        return ExpertTemplateDetail(
            template_id=entry.template_id,
            version=entry.version,
            display_name=entry.display_name,
            persona=payload.get("persona"),
            recommended_config=payload.get("recommended_config", {}),
            default_model_json=payload.get("default_model_json", {}),
            default_binding_json=payload.get("default_binding_json", {}),
            prompt_pack_json=payload.get("prompt_pack_json", {}),
            category_code=payload.get("category_code", ""),
            role_name=payload.get("role_name", ""),
        )

    def pull_solution_package(
        self, *, solution_id: str, version: str | None = None
    ):
        """F07：Manager 拉取行业方案包（只读；Operator 持模板真相）。

        version 为 None 时返回最新已发布版本。只返回 PUBLISHED 状态的方案。
        """
        from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
        from shared.errors import NotFound

        entry = self._repo.get(CatalogType.SOLUTION_TEMPLATE, solution_id)
        if entry.status != CatalogStatus.PUBLISHED:
            raise NotFound(f"solution package not published: {solution_id}")
        if version is not None and entry.version != version:
            raise NotFound(f"solution package version mismatch: {solution_id}@{version}")

        payload = entry.payload or {}

        # 解析方案包中引用的专家模板。
        # expert_bindings 为权威源（含 template_id/sequence_no/enabled），优先于派生的
        # expert_template_ids，避免双源不同步导致拉取到过期专家。
        bindings_meta = payload.get("expert_bindings") or []
        if bindings_meta:
            binding_order = [b["template_id"] for b in bindings_meta]
            binding_overrides = {b["template_id"]: b for b in bindings_meta}
        else:
            binding_order = payload.get("expert_template_ids", [])
            binding_overrides = {}
        experts: list[ExpertTemplateDetail] = []
        for expert_id in binding_order:
            try:
                expert = self.pull_expert_template_detail(template_id=expert_id, version=None)
                override = binding_overrides.get(expert_id)
                if override is not None:
                    expert.sequence_no = override.get("sequence_no", 1)
                    expert.enabled = override.get("enabled", True)
                experts.append(expert)
            except Exception:  # noqa: BLE001
                # 跳过不存在或未发布的专家模板（方案可能引用了已下架的模板）
                pass

        return SolutionPackage(
            solution_id=entry.template_id,
            version=entry.version,
            display_name=entry.display_name,
            experts=experts,
            knowledge_refs=payload.get("knowledge_refs", []),
            skill_refs=payload.get("skill_refs", []),
            default_grants=payload.get("default_grants"),
            planner_prompt=payload.get("planner_prompt", ""),
            subtask_prompt=payload.get("subtask_prompt", ""),
            aggregate_prompt=payload.get("aggregate_prompt", ""),
            default_kb_blueprint=payload.get("default_kb_blueprint", {}),
            default_skill_bundle=payload.get("default_skill_bundle", {}),
            default_collaboration_template_ref=payload.get("default_collaboration_template_ref"),
            tags=payload.get("tags", []),
        )

    def list_published_expert_templates(self):
        """F06：Manager 列举可招募专家模板（只读，只返回 PUBLISHED 状态）。"""
        from shared.contracts.crosstier import ExpertTemplateDetail

        entries = self._repo.list(
            catalog_type=CatalogType.EXPERT_TEMPLATE, status=CatalogStatus.PUBLISHED
        )
        results: list[ExpertTemplateDetail] = []
        for entry in entries:
            payload = entry.payload or {}
            results.append(
                ExpertTemplateDetail(
                    template_id=entry.template_id,
                    version=entry.version,
                    display_name=entry.display_name,
                    persona=payload.get("persona"),
                    recommended_config=payload.get("recommended_config", {}),
                    default_model_json=payload.get("default_model_json", {}),
                    default_binding_json=payload.get("default_binding_json", {}),
                    prompt_pack_json=payload.get("prompt_pack_json", {}),
                    category_code=payload.get("category_code", ""),
                    role_name=payload.get("role_name", ""),
                )
            )
        return results

    def list_published_solution_packages(self):
        """F07：Manager 列举可应用行业方案包（只读，只返回 PUBLISHED 状态）。"""
        from shared.contracts.crosstier import SolutionPackage

        entries = self._repo.list(
            catalog_type=CatalogType.SOLUTION_TEMPLATE, status=CatalogStatus.PUBLISHED
        )
        results: list[SolutionPackage] = []
        for entry in entries:
            try:
                package = self.pull_solution_package(solution_id=entry.template_id, version=None)
                results.append(package)
            except Exception:  # noqa: BLE001
                # 跳过解析失败的方案包
                pass
        return results

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
