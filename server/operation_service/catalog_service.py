"""目录发布/下架/可见范围编排（05 F03，D1）。

模板真相态归 Operator：注册=草稿（不外溢），发布/下架/可见范围变更=落本端真相 +
经窄通道通知 Manager（CatalogReleaseNotify，写调用带 Idempotency-Key）。

红线（CLAUDE/AGENTS §8 / F03）：Operator 持模板真相但**不写 Manager 租户库**（只服务通知）；
不做招募（M6，归 Manager）。
"""

from __future__ import annotations

from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.errors import Conflict, NotFound

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
_ID_RANDOM_LENGTH = 4
_ID_MAX_ATTEMPTS = 8


def _slugify_id(display_name: str, *, random_suffix: str) -> str:
    """ASCII slug 候选：白名单 [a-z0-9]，其余规约为连字符，全空回落 "item"。"""
    import re

    text = (display_name or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text, flags=re.UNICODE)
    base = text.strip("-") or "item"
    return f"{base}-{random_suffix}"


def _derive_id(display_name: str) -> str:
    """可读 slug + 短随机后缀。"""
    import secrets

    return _slugify_id(display_name, random_suffix=secrets.token_hex(_ID_RANDOM_LENGTH // 2))


def _fallback_id() -> str:
    """uuid4 兜底，与任何 slug 派生不重叠。"""
    import uuid

    return f"item-{uuid.uuid4().hex[:8]}"


def _with_auto_id(repo, make_entry, display_name, *, attempts=_ID_MAX_ATTEMPTS):
    """自动生成 ID 并创建条目；冲突则重试，极端情况 uuid4 兜底。"""
    for _ in range(attempts):
        try:
            return repo.create(make_entry(_derive_id(display_name)))
        except Conflict:
            continue
    return repo.create(make_entry(_fallback_id()))



def _to_response(entry: CatalogEntry) -> CatalogEntryResponse:
    payload = entry.payload or {}
    return CatalogEntryResponse(
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
        category=payload.get("category", ""),
        avatar_url=payload.get("avatar_url", ""),
        system_prompt=payload.get("system_prompt", ""),
        platform_model_ref=payload.get("platform_model_ref"),
        skill_ids=payload.get("skill_ids", []),
        platform_skill_refs=payload.get("platform_skill_refs", []),
        tags=payload.get("tags", []),
        description=payload.get("description", ""),
        initial_memories=payload.get("initial_memories", []),
        sort_order=payload.get("sort_order", 0),
        expert_bindings=payload.get("expert_bindings"),
        coordinator_template_id=payload.get("coordinator_template_id", ""),
        coordinator_instructions=payload.get("coordinator_instructions", ""),
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


def _resolve_coordinator_template_id(
    coordinator_template_id: str,
    bindings: list[ExpertBinding],
) -> str:
    """校验并归一化方案协调专家指定。"""
    from shared.errors import ValidationProblem

    coordinator_id = (coordinator_template_id or "").strip()
    if not coordinator_id:
        raise ValidationProblem(
            "coordinator_template_id is required: designate one expert as the coordinator"
        )
    bound = {b.template_id for b in bindings}
    if coordinator_id not in bound:
        raise ValidationProblem(
            f"coordinator_template_id {coordinator_id!r} is not among the bound experts: {sorted(bound)}"
        )
    return coordinator_id


def _normalize_coordinator_instructions(instructions: str) -> str:
    """Normalize optional natural-language collaboration instructions."""
    return (instructions or "").strip()

def _to_detail_view(entry: CatalogEntry) -> "CatalogDetailView":
    """Construct a CatalogDetailView from a CatalogEntry, populating all payload fields."""
    from .catalog_schemas import CatalogDetailView

    payload = entry.payload or {}
    return CatalogDetailView(
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
        category=payload.get("category", ""),
        avatar_url=payload.get("avatar_url", ""),
        system_prompt=payload.get("system_prompt", ""),
        platform_model_ref=payload.get("platform_model_ref"),
        skill_ids=payload.get("skill_ids", []),
        platform_skill_refs=payload.get("platform_skill_refs", []),
        tags=payload.get("tags", []),
        description=payload.get("description", ""),
        initial_memories=payload.get("initial_memories", []),
        sort_order=payload.get("sort_order", 0),
        expert_bindings=payload.get("expert_bindings"),
        expert_template_ids=payload.get("expert_template_ids", []),
        coordinator_template_id=payload.get("coordinator_template_id", ""),
        coordinator_instructions=payload.get("coordinator_instructions", ""),
    )


class CatalogService:
    """无状态编排器；依赖注入 repository 与 Manager 网关（对端可 mock）。"""

    def __init__(self, repo: CatalogRepository, manager: CatalogManagerGateway, *, platform_skills=None, platform_providers=None):
        self._repo = repo
        self._manager = manager
        self._platform_skills = platform_skills
        self._platform_providers = platform_providers

    # ---- 注册（草稿态，不通知 Manager）----

    def register_expert_template(
        self, req: RegisterExpertTemplateRequest
    ) -> CatalogEntryResponse:
        self._validate_platform_skill_refs(req.platform_skill_refs)
        self._validate_platform_model_ref(req.platform_model_ref)

        def make(candidate: str) -> CatalogEntry:
            return CatalogEntry(
                catalog_type=CatalogType.EXPERT_TEMPLATE,
                template_id=candidate,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "category": req.category,
                    "avatar_url": req.avatar_url,
                    "system_prompt": req.system_prompt,
                    "platform_model_ref": req.platform_model_ref.model_dump(mode="json"),
                    "skill_ids": [],
                    "platform_skill_refs": [ref.model_dump(mode="json") for ref in req.platform_skill_refs],
                    "tags": [],
                    "description": req.description,
                },
            )

        if req.template_id and req.template_id.strip():
            return _to_response(self._repo.create(make(req.template_id.strip())))
        entry = _with_auto_id(self._repo, make, req.display_name)
        return _to_response(entry)

    def register_solution_template(
        self, req: RegisterSolutionTemplateRequest
    ) -> CatalogEntryResponse:
        def make(candidate: str) -> CatalogEntry:
            bindings = _normalize_expert_bindings(req.expert_bindings, req.expert_template_ids)
            coordinator_id = _resolve_coordinator_template_id(req.coordinator_template_id, bindings)
            coordinator_instructions = _normalize_coordinator_instructions(req.coordinator_instructions)
            return CatalogEntry(
                catalog_type=CatalogType.SOLUTION_TEMPLATE,
                template_id=candidate,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "description": req.description,
                    "icon": req.icon,
                    "expert_template_ids": [b.template_id for b in bindings],
                    "expert_bindings": [
                        {
                            "template_id": b.template_id,
                            "sequence_no": b.sequence_no,
                            "enabled": b.enabled,
                        }
                        for b in bindings
                    ],
                    "coordinator_template_id": coordinator_id,
                    "coordinator_instructions": coordinator_instructions,
                    "tags": req.tags,
                },
            )

        if req.solution_id and req.solution_id.strip():
            return _to_response(self._repo.create(make(req.solution_id.strip())))
        entry = _with_auto_id(self._repo, make, req.display_name)
        return _to_response(entry)

    def _validate_platform_skill_refs(self, refs) -> None:
        if refs and self._platform_skills is None:
            from shared.errors import AppError
            exc = AppError("Operator platform skill store is not configured")
            exc.status, exc.code, exc.title = 503, "operator_skill_store_unavailable", "Operator skill store unavailable"
            raise exc
        if self._platform_skills is None:
            return
        for ref in refs:
            row = self._platform_skills.get_package(skill_id=ref.skill_id, version=ref.version, published_only=True)
            if row["content_hash"] != ref.content_hash:
                raise Conflict("platform skill reference content hash does not match the published version")

    def _validate_platform_model_ref(self, ref) -> None:
        if self._platform_providers is None:
            from shared.errors import AppError
            exc = AppError("Operator platform Provider store is not configured")
            exc.status, exc.code, exc.title = 503, "operator_provider_store_unavailable", "Operator Provider store unavailable"
            raise exc
        self._platform_providers.validate_model_ref(ref, require_published=True)

    # ---- 生命周期：发布 / 下架 / 可见范围 ----

    def publish_template(
        self, catalog_type: CatalogType, template_id: str, req: PublishTemplateRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.get(catalog_type, template_id)
        if catalog_type == CatalogType.EXPERT_TEMPLATE:
            from shared.contracts.platform_provider import PlatformModelRef
            from shared.contracts.platform_skill import PlatformSkillRef
            payload = entry.payload or {}
            refs = [PlatformSkillRef.model_validate(ref) for ref in payload.get("platform_skill_refs", [])]
            self._validate_platform_skill_refs(refs)
            self._validate_platform_model_ref(PlatformModelRef.model_validate(payload.get("platform_model_ref")))
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


    # ---- 详情（含 payload）----

    def get_entry_detail(
        self, catalog_type: CatalogType, template_id: str
    ) -> CatalogDetailView:
        """GET 详情接口返回 payload（响应反哺前端多 section 渲染）。"""
        entry = self._repo.get(catalog_type, template_id)
        return _to_detail_view(entry)

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
        其余字段（persona/recommended_config/expert_template_ids/coordinator_template_id/
        coordinator_instructions）合并进 payload，避免 dataclasses.replace 收到
        未定义字段抛出 TypeError → 500。

        body 中 None 值已在 routes 层经 exclude_none 排除，此处 changes 不含 None。
        """
        entry = self._repo.get(catalog_type, template_id)
        if catalog_type == CatalogType.EXPERT_TEMPLATE and "platform_skill_refs" in changes:
            from shared.contracts.platform_skill import PlatformSkillRef
            self._validate_platform_skill_refs([PlatformSkillRef.model_validate(ref) for ref in changes["platform_skill_refs"]])
        if catalog_type == CatalogType.EXPERT_TEMPLATE and "platform_model_ref" in changes:
            from shared.contracts.platform_provider import PlatformModelRef
            self._validate_platform_model_ref(PlatformModelRef.model_validate(changes["platform_model_ref"]))
        # 分离 payload 字段与 dataclass 顶层字段
        _top_fields = {'catalog_type', 'template_id', 'version', 'display_name',
                       'status', 'visible_scope', 'payload'}
        payload_updates = {k: v for k, v in changes.items() if k not in _top_fields}
        top_updates = {k: v for k, v in changes.items() if k in _top_fields}
        if payload_updates:
            new_payload = {**(entry.payload or {}), **payload_updates}
            top_updates['payload'] = new_payload
        # 行业方案编辑后重新校验协调专家完整性。
        if (
            entry.catalog_type == CatalogType.SOLUTION_TEMPLATE
            and top_updates.get("payload") is not None
        ):
            self._validate_solution_coordinator_integrity(top_updates["payload"])
        updated = self._repo.update(entry, **top_updates)
        return _to_response(updated)

    @staticmethod
    def _validate_solution_coordinator_integrity(payload: dict) -> None:
        """编辑行业方案后校验协调专家仍属于当前专家 roster。"""
        from shared.errors import ValidationProblem

        bindings = payload.get("expert_bindings") or []
        bound_ids = {b["template_id"] for b in bindings} if bindings else set(payload.get("expert_template_ids", []))
        if not bound_ids:
            raise ValidationProblem("a solution template must have at least one bound expert")
        coordinator_id = (payload.get("coordinator_template_id") or "").strip()
        if not coordinator_id:
            raise ValidationProblem("coordinator_template_id must not be empty for a solution template")
        if coordinator_id not in bound_ids:
            raise ValidationProblem(
                f"coordinator_template_id {coordinator_id!r} is not among the bound experts: {sorted(bound_ids)}"
            )


    def list_entry_details(
        self,
        *,
        catalog_type: CatalogType | None = None,
        status: CatalogStatus | None = None,
    ) -> list[CatalogDetailView]:
        return [
            _to_detail_view(e)
            for e in self._repo.list(catalog_type=catalog_type, status=status)
        ]

    @staticmethod
    def _backfill_expert(payload: dict) -> tuple[str | None, dict]:
        """从 PRD-v2 平铺字段回填 Manager 招募路径消费的 persona / recommended_config。

        Manager recruit 读 template.persona 与 template.recommended_config 中的模型和专家能力配置。
        注册端已改为 flat 字段后，跨端 pull 时把 system_prompt → persona、
        platform_model_ref → recommended_config 的 provider/model 固定引用，skill refs 同步回去，
        避免联动 manager 侧。
        """
        if not payload:
            return None, {}
        persona = payload.get("system_prompt") or None
        recommended: dict = {}
        if payload.get("platform_model_ref"):
            model_ref = dict(payload["platform_model_ref"])
            recommended["platform_model_ref"] = model_ref
            recommended["provider_ref"] = model_ref["provider_id"]
            recommended["provider_version"] = model_ref["provider_version"]
            recommended["model"] = model_ref["model_id"]
            recommended["model_version"] = model_ref["model_version"]
        refs = payload.get("platform_skill_refs") or []
        if refs:
            recommended["platform_skill_refs"] = list(refs)
            recommended["skills"] = [str(ref.get("skill_id")) for ref in refs if isinstance(ref, dict) and ref.get("skill_id")]
        return persona, recommended

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
        persona, recommended = self._backfill_expert(payload)
        return ExpertTemplateDetail(
            template_id=entry.template_id,
            version=entry.version,
            display_name=entry.display_name,
            persona=persona,
            recommended_config=recommended,
            category=payload.get("category", ""),
            avatar_url=payload.get("avatar_url", ""),
            system_prompt=payload.get("system_prompt", ""),
            platform_model_ref=payload.get("platform_model_ref"),
            skill_ids=payload.get("skill_ids", []),
            platform_skill_refs=payload.get("platform_skill_refs", []),
            description=payload.get("description", ""),
            initial_memories=payload.get("initial_memories", []),
            sort_order=payload.get("sort_order", 0),
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
            description=payload.get("description", ""),
            icon=payload.get("icon", ""),
            coordinator_template_id=payload.get("coordinator_template_id", ""),
            coordinator_instructions=payload.get("coordinator_instructions", ""),
            experts=experts,
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
            persona, recommended = self._backfill_expert(payload)
            results.append(
                ExpertTemplateDetail(
                    template_id=entry.template_id,
                    version=entry.version,
                    display_name=entry.display_name,
                    persona=persona,
                    recommended_config=recommended,
                    category=payload.get("category", ""),
                    avatar_url=payload.get("avatar_url", ""),
                    system_prompt=payload.get("system_prompt", ""),
                    platform_model_ref=payload.get("platform_model_ref"),
                    skill_ids=payload.get("skill_ids", []),
                    platform_skill_refs=payload.get("platform_skill_refs", []),
                    description=payload.get("description", ""),
                    initial_memories=payload.get("initial_memories", []),
                    sort_order=payload.get("sort_order", 0),
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

        通知是 best-effort：Operator 已落本端真相（模板状态/可见范围），Manager 可经
        F06/F07 按需拉取最新数据。通知失败（Manager 不可达或尚未实现收端）只记日志，
        不阻断发布/下架操作——否则会导致用户侧操作因对端基础设施问题而整体失败。
        """
        import logging

        logger = logging.getLogger(__name__)
        try:
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
        except Exception:  # noqa: BLE001
            logger.warning(
                "Manager 目录通知失败（best-effort，不影响本端真相）: "
                "type=%s id=%s action=%s",
                entry.catalog_type.value,
                entry.template_id,
                action,
                exc_info=True,
            )
