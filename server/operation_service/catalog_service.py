"""目录发布/下架/可见范围编排（05 F03，D1）。

模板真相态归 Operator：注册=草稿（不外溢），发布/下架/可见范围变更=落本端真相 +
经窄通道通知 Manager（CatalogReleaseNotify，写调用带 Idempotency-Key）。

红线（CLAUDE/AGENTS §8 / F03）：Operator 持模板真相但**不写 Manager 租户库**（只服务通知）；
不做招募（M6，归 Manager）。
"""

from __future__ import annotations

from datetime import datetime, timezone

from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.expert_profile import EXPERT_PROFILE_FIELDS, profile_from_payload
from shared.errors import Conflict, NotFound, ServiceUnavailable, ValidationProblem
from shared.solution_authoring.orchestration import (
    OrchestrationRefError,
    validate_member_refs,
)

from shared.avatar_image import AvatarFile, AvatarImageError, normalize_avatar

from .catalog_avatar import KEEP_AVATAR, TemplateAvatarNotFound, avatar_url_for, avatar_version, parse_avatar_upload
from .template_avatar_store import TemplateAvatarStore
from .catalog_gateway import CatalogManagerGateway
from .catalog_repository import CatalogEntry, CatalogRepository
from .catalog_schemas import (
    CatalogDetailView,
    CatalogEntryResponse,
    ExpertBinding,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
    SetVisibilityRequest,
)
from .catalog_scope import (
    TemplateOutOfScope,
    VisibleScope,
    normalize_scope,
    scope_allows,
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



def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _updated_at(payload: dict) -> datetime | None:
    """读取 payload 中的模板更新时间；旧模板缺失或格式不合法时为 None。"""
    value = payload.get("updated_at")
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _profile_projection(payload: dict) -> dict:
    """人才市场展示字段 + updated_at 投影；旧模板按默认值返回。"""
    return {**profile_from_payload(payload).model_dump(), "updated_at": _updated_at(payload)}


def _solution_projection(entry: CatalogEntry) -> dict:
    """行业方案的类型、规则与推荐能力（只读）；专家模板不带。"""
    if entry.catalog_type != CatalogType.SOLUTION_TEMPLATE:
        return {}
    payload = entry.payload or {}
    return {
        "mode": "solo" if payload.get("mode") == "solo" else "group",
        "orchestration_rules": payload.get("orchestration_rules", "") or "",
        "recommended_capabilities": payload.get("recommended_capabilities", []) or [],
    }


def _to_response(entry: CatalogEntry) -> CatalogEntryResponse:
    payload = entry.payload or {}
    return CatalogEntryResponse(
        **_profile_projection(payload),
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
        category=payload.get("category", ""),
        avatar_url=avatar_url_for(entry.template_id, payload),
        avatar_version=avatar_version(payload),
        system_prompt=payload.get("system_prompt", ""),
        skill_ids=payload.get("skill_ids", []),
        platform_skill_refs=payload.get("platform_skill_refs", []),
        tags=payload.get("tags", []),
        description=payload.get("description", ""),
        initial_memories=payload.get("initial_memories", []),
        sort_order=payload.get("sort_order", 0),
        expert_bindings=payload.get("expert_bindings"),
        coordinator_template_id=payload.get("coordinator_template_id", ""),
        coordinator_instructions=payload.get("coordinator_instructions", ""),
        **_solution_projection(entry),
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
    bound = {b.template_id for b in bindings if b.enabled}
    if coordinator_id not in bound:
        raise ValidationProblem(
            f"coordinator_template_id {coordinator_id!r} must be one of the enabled experts: {sorted(bound)}"
        )
    return coordinator_id


def _normalize_coordinator_instructions(instructions: str) -> str:
    """Normalize optional natural-language collaboration instructions."""
    return (instructions or "").strip()

def _to_detail_view(entry: CatalogEntry) -> CatalogDetailView:
    """Construct a CatalogDetailView from a CatalogEntry, populating all payload fields."""
    payload = entry.payload or {}
    return CatalogDetailView(
        **_profile_projection(payload),
        catalog_type=entry.catalog_type,
        template_id=entry.template_id,
        version=entry.version,
        display_name=entry.display_name,
        status=entry.status,
        visible_scope=entry.visible_scope,
        category=payload.get("category", ""),
        avatar_url=avatar_url_for(entry.template_id, payload),
        avatar_version=avatar_version(payload),
        system_prompt=payload.get("system_prompt", ""),
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
        **_solution_projection(entry),
    )


class CatalogService:
    """无状态编排器；依赖注入 repository 与 Manager 网关（对端可 mock）。"""

    def __init__(self, repo: CatalogRepository, manager: CatalogManagerGateway, *, platform_skills=None, platform_providers=None, enterprises=None, avatars: TemplateAvatarStore | None = None):
        self._repo = repo
        self._avatars = avatars
        self._manager = manager
        self._platform_skills = platform_skills
        self._platform_providers = platform_providers
        self._enterprises = enterprises

    # ---- 注册（草稿态，不通知 Manager）----

    def register_expert_template(
        self, req: RegisterExpertTemplateRequest
    ) -> CatalogEntryResponse:
        self._validate_platform_skill_refs(req.platform_skill_refs)
        avatar = self._prepare_avatar(req.avatar_url)
        avatar = avatar if isinstance(avatar, AvatarFile) else None
        avatar_meta = {"avatar_version": 1, "avatar_sha256": avatar.sha256} if avatar else {}

        def make(candidate: str) -> CatalogEntry:
            return CatalogEntry(
                catalog_type=CatalogType.EXPERT_TEMPLATE,
                template_id=candidate,
                version=_INITIAL_VERSION,
                display_name=req.display_name,
                payload={
                    "category": req.category,
                    **avatar_meta,
                    "system_prompt": req.system_prompt,
                    "skill_ids": [],
                    "platform_skill_refs": [ref.model_dump(mode="json") for ref in req.platform_skill_refs],
                    "tags": [],
                    "description": req.description,
                    **req.model_dump(mode="json", include=set(EXPERT_PROFILE_FIELDS)),
                    "updated_at": _now_iso(),
                },
            )

        if req.template_id and req.template_id.strip():
            entry = self._repo.create(make(req.template_id.strip()))
        else:
            entry = _with_auto_id(self._repo, make, req.display_name)
        if avatar is not None:
            self._write_avatar_for_new_entry(entry, avatar)
        return _to_response(entry)

    # ---- 模板头像（文件存储，payload 只记版本与摘要）----

    def _prepare_avatar(self, value: object):
        """请求里的 avatar_url → 规范化后的 AvatarFile / None（删除）/ KEEP_AVATAR（不变）。"""
        parsed = parse_avatar_upload(value)
        if parsed is None or parsed is KEEP_AVATAR:
            return parsed
        if self._avatars is None:
            raise ServiceUnavailable("template avatar storage is not configured on this Operator")
        try:
            return normalize_avatar(parsed)
        except AvatarImageError as exc:
            raise ValidationProblem(str(exc)) from exc

    def _write_avatar_for_new_entry(self, entry: CatalogEntry, avatar: AvatarFile) -> None:
        """新建模板后落盘头像文件；落盘失败则撤掉 payload 里的头像版本，避免指向不存在的文件。"""
        try:
            self._avatars.write(entry.template_id, avatar.data)
        except Exception:
            payload = {k: v for k, v in (entry.payload or {}).items() if k not in {"avatar_version", "avatar_sha256"}}
            self._repo.update(entry, payload=payload)
            raise

    def read_template_avatar(self, template_id: str, *, tenant_id: str | None = None) -> tuple[bytes, int, str]:
        """读取专家模板头像文件：返回 (字节, 版本, sha256)。

        tenant_id 不为空表示 Manager 服务间拉取：只给已发布且对该租户可见的模板。
        """
        entry = self._repo.get(CatalogType.EXPERT_TEMPLATE, template_id)
        if tenant_id is not None:
            if entry.status != CatalogStatus.PUBLISHED:
                raise NotFound(f"expert template not published: {template_id}")
            if not self._visible_to(entry, tenant_id):
                raise TemplateOutOfScope(f"expert template not visible: {template_id}")
        payload = entry.payload or {}
        version = avatar_version(payload)
        data = self._avatars.read(template_id) if (version and self._avatars is not None) else None
        if data is None:
            raise TemplateAvatarNotFound(f"expert template has no avatar: {template_id}")
        return data, version, str(payload.get("avatar_sha256") or "")

    def register_solution_template(
        self, req: RegisterSolutionTemplateRequest
    ) -> CatalogEntryResponse:
        def make(candidate: str) -> CatalogEntry:
            bindings = _normalize_expert_bindings(req.expert_bindings, req.expert_template_ids)
            coordinator_id = _resolve_coordinator_template_id(req.coordinator_template_id, bindings)
            coordinator_instructions = _normalize_coordinator_instructions(req.coordinator_instructions)
            template_versions: dict[str, str] = {}
            for binding in bindings:
                try:
                    template_versions[binding.template_id] = self._repo.get(CatalogType.EXPERT_TEMPLATE, binding.template_id).version
                except Exception:  # noqa: BLE001 — drafts may be registered before their expert templates
                    continue
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
                    "output_requirements": (req.output_requirements or "").strip(),
                    "mode": req.mode,
                    "orchestration_rules": req.orchestration_rules.strip(),
                    "recommended_capabilities": [item.model_dump(mode="json") for item in req.recommended_capabilities],
                    "expert_template_versions": template_versions,
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

    # ---- 生命周期：发布 / 下架 / 可见范围 ----

    def publish_template(
        self, catalog_type: CatalogType, template_id: str, req: PublishTemplateRequest
    ) -> CatalogEntryResponse:
        entry = self._repo.get(catalog_type, template_id)
        if catalog_type == CatalogType.EXPERT_TEMPLATE:
            from shared.contracts.platform_skill import PlatformSkillRef
            payload = entry.payload or {}
            refs = [PlatformSkillRef.model_validate(ref) for ref in payload.get("platform_skill_refs", [])]
            self._validate_platform_skill_refs(refs)
        if entry.status == CatalogStatus.PUBLISHED:
            raise Conflict(f"already published: {template_id}")
        updated = self._repo.update(
            entry, status=CatalogStatus.PUBLISHED,
            visible_scope=(req.visible_scope or VisibleScope()).model_dump(mode="json"),
            payload={**(entry.payload or {}), "updated_at": _now_iso()},
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
        updated = self._repo.update(entry, visible_scope=req.visible_scope.model_dump(mode="json"))
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
        if catalog_type == CatalogType.SOLUTION_TEMPLATE and set(changes) & set(EXPERT_PROFILE_FIELDS):
            raise ValidationProblem("talent market profile fields apply to expert templates only")
        avatar_write: AvatarFile | None = None
        avatar_delete = False
        if catalog_type == CatalogType.EXPERT_TEMPLATE and "avatar_url" in changes:
            changes = dict(changes)
            avatar = self._prepare_avatar(changes.pop("avatar_url"))
            current = entry.payload or {}
            if avatar is None and avatar_version(current):
                changes.update(avatar_version=None, avatar_sha256=None)
                avatar_delete = True
            elif isinstance(avatar, AvatarFile) and avatar.sha256 != current.get("avatar_sha256"):
                changes.update(avatar_version=(avatar_version(current) or 0) + 1, avatar_sha256=avatar.sha256)
                avatar_write = avatar
        elif "avatar_url" in changes:
            raise ValidationProblem("avatar applies to expert templates only")
        if catalog_type == CatalogType.EXPERT_TEMPLATE and "platform_skill_refs" in changes:
            from shared.contracts.platform_skill import PlatformSkillRef
            self._validate_platform_skill_refs([PlatformSkillRef.model_validate(ref) for ref in changes["platform_skill_refs"]])
        # 分离 payload 字段与 dataclass 顶层字段
        _top_fields = {'catalog_type', 'template_id', 'version', 'display_name',
                       'status', 'visible_scope', 'payload'}
        payload_updates = {k: v for k, v in changes.items() if k not in _top_fields}
        # expert_bindings 是拉取方案时的权威名单：只改 expert_template_ids 时按新名单重建，
        # 已有专家保留原启用状态，否则改了专家名单也不会生效。
        if (
            entry.catalog_type == CatalogType.SOLUTION_TEMPLATE
            and "expert_template_ids" in payload_updates and "expert_bindings" not in payload_updates
        ):
            enabled = {b.get("template_id"): b.get("enabled", True) for b in (entry.payload or {}).get("expert_bindings") or []}
            payload_updates["expert_bindings"] = [
                {"template_id": tid, "sequence_no": idx, "enabled": enabled.get(tid, True)}
                for idx, tid in enumerate(payload_updates["expert_template_ids"], start=1)
            ]
        top_updates = {k: v for k, v in changes.items() if k in _top_fields}
        if payload_updates:
            new_payload = {**(entry.payload or {}), **payload_updates, "updated_at": _now_iso()}
            top_updates['payload'] = new_payload
        # 行业方案编辑后重新校验协调专家完整性。
        if (
            entry.catalog_type == CatalogType.SOLUTION_TEMPLATE
            and top_updates.get("payload") is not None
        ):
            self._validate_solution_coordinator_integrity(top_updates["payload"])
        # 先落盘再提交新版本号：读到新版本的一方一定能拿到新文件。
        if avatar_write is not None:
            self._avatars.write(template_id, avatar_write.data)
        updated = self._repo.update(entry, **top_updates)
        if avatar_delete and self._avatars is not None:
            self._avatars.delete(template_id)
        return _to_response(updated)

    @staticmethod
    def _validate_solution_coordinator_integrity(payload: dict) -> None:
        """编辑行业方案后校验协调专家仍属于当前专家 roster。"""
        from shared.errors import ValidationProblem

        bindings = payload.get("expert_bindings") or []
        bound_ids = {b["template_id"] for b in bindings} if bindings else set(payload.get("expert_template_ids", []))
        enabled_ids = {b["template_id"] for b in bindings if b.get("enabled", True)} if bindings else bound_ids
        if not bound_ids:
            raise ValidationProblem("a solution template must have at least one bound expert")
        coordinator_id = (payload.get("coordinator_template_id") or "").strip()
        if not coordinator_id:
            raise ValidationProblem("coordinator_template_id must not be empty for a solution template")
        if coordinator_id not in enabled_ids:
            raise ValidationProblem(
                f"coordinator_template_id {coordinator_id!r} must be one of the enabled experts: {sorted(enabled_ids)}"
            )
        # 类型与编排规则在目录里只读：改专家或群主时不能让它们失效，否则企业应用时才会失败。
        if payload.get("mode") == "solo" and len(enabled_ids) != 1:
            raise ValidationProblem("这是单人方案，必须正好启用 1 位专家；如需多位专家，请在行业文档生成里改成组群方案后重新发布")
        rules = (payload.get("orchestration_rules") or "").strip()
        if rules:
            try:
                validate_member_refs(rules, frozenset(enabled_ids))
            except OrchestrationRefError as exc:
                listed = "、".join(exc.members) if exc.members else ""
                raise ValidationProblem(
                    f"群聊编排规则引用了不在已启用专家里的成员{f'：{listed}' if listed else ''}；请保留这些专家，或在行业文档生成里修改规则后重新发布"
                ) from exc


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
        skill refs 同步回 recommended_config（模型与思考档位不属于模板，由企业招募时选择），
        避免联动 manager 侧。
        """
        if not payload:
            return None, {}
        persona = payload.get("system_prompt") or None
        recommended: dict = {}
        refs = payload.get("platform_skill_refs") or []
        if refs:
            recommended["platform_skill_refs"] = list(refs)
            recommended["skills"] = [str(ref.get("skill_id")) for ref in refs if isinstance(ref, dict) and ref.get("skill_id")]
        return persona, recommended

    # ---- Manager 拉取详情（F06/F07 跨端契约，05 §5.4）----

    def _visible_to(self, entry: CatalogEntry, tenant_id: str | None) -> bool:
        """发布范围是否对该企业可见。`tenant_id=None` 仅限内部调用；拿不到企业资料时按不可见处理。"""
        if tenant_id is None or normalize_scope(entry.visible_scope).mode == "all":
            return True
        if self._enterprises is None:
            return False
        try:
            account = self._enterprises.get_by_tenant_id(tenant_id)
        except NotFound:
            return False
        return scope_allows(entry.visible_scope, industry=account.industry, tags=account.tags)

    def _expert_visible(self, template_id: str, tenant_id: str) -> bool:
        try:
            entry = self._repo.get(CatalogType.EXPERT_TEMPLATE, template_id)
        except NotFound:
            return True  # 缺失的专家由后面的“方案不完整”冲突报告，不当作范围外
        return self._visible_to(entry, tenant_id)

    def _expert_name(self, template_id: str) -> str:
        try:
            return self._repo.get(CatalogType.EXPERT_TEMPLATE, template_id).display_name
        except NotFound:
            return ""

    def pull_expert_template_detail(
        self, *, template_id: str, version: str | None = None, tenant_id: str | None = None
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
        if not self._visible_to(entry, tenant_id):
            raise TemplateOutOfScope(f"expert template not visible: {template_id}")

        payload = entry.payload or {}
        persona, recommended = self._backfill_expert(payload)
        return ExpertTemplateDetail(
            **_profile_projection(payload),
            template_id=entry.template_id,
            version=entry.version,
            display_name=entry.display_name,
            persona=persona,
            recommended_config=recommended,
            category=payload.get("category", ""),
            avatar_url=avatar_url_for(entry.template_id, payload, pull=True),
            avatar_version=avatar_version(payload),
            system_prompt=payload.get("system_prompt", ""),
            skill_ids=payload.get("skill_ids", []),
            platform_skill_refs=payload.get("platform_skill_refs", []),
            description=payload.get("description", ""),
            initial_memories=payload.get("initial_memories", []),
            sort_order=payload.get("sort_order", 0),
        )

    def pull_solution_package(
        self, *, solution_id: str, version: str | None = None, tenant_id: str | None = None
    ):
        """F07：Manager 拉取行业方案包（只读；Operator 持模板真相）。

        version 为 None 时返回最新已发布版本。只返回 PUBLISHED 状态的方案。
        """
        from shared.contracts.crosstier import (
            ExpertTemplateDetail,
            HiddenExpertRef,
            SolutionPackage,
        )
        from shared.errors import Conflict, NotFound

        entry = self._repo.get(CatalogType.SOLUTION_TEMPLATE, solution_id)
        if entry.status != CatalogStatus.PUBLISHED:
            raise NotFound(f"solution package not published: {solution_id}")
        if version is not None and entry.version != version:
            raise NotFound(f"solution package version mismatch: {solution_id}@{version}")
        if not self._visible_to(entry, tenant_id):
            raise TemplateOutOfScope(f"solution package not visible: {solution_id}")

        payload = entry.payload or {}

        # 解析方案包中引用的专家模板。
        # expert_bindings 为权威源（含 template_id/sequence_no/enabled），优先于派生的
        # expert_template_ids，避免双源不同步导致拉取到过期专家。
        bindings_meta = payload.get("expert_bindings") or []
        template_versions = payload.get("expert_template_versions") or {}
        if bindings_meta:
            binding_order = [b["template_id"] for b in bindings_meta]
            binding_overrides = {b["template_id"]: b for b in bindings_meta}
        else:
            binding_order = payload.get("expert_template_ids", [])
            binding_overrides = {}
        experts: list[ExpertTemplateDetail] = []
        hidden_ids: set[str] = set()
        hidden_refs: list[HiddenExpertRef] = []
        for expert_id in binding_order:
            if tenant_id is not None and not self._expert_visible(expert_id, tenant_id):
                hidden_ids.add(expert_id)
                hidden_refs.append(HiddenExpertRef(template_id=expert_id, display_name=self._expert_name(expert_id)))
                continue
            try:
                pinned_version = template_versions.get(expert_id) if isinstance(template_versions, dict) else None
                expert = self.pull_expert_template_detail(template_id=expert_id, version=pinned_version if isinstance(pinned_version, str) and pinned_version else None)
                override = binding_overrides.get(expert_id)
                if override is not None:
                    expert.sequence_no = override.get("sequence_no", 1)
                    expert.enabled = override.get("enabled", True)
                experts.append(expert)
            except Exception as exc:  # noqa: BLE001
                # 方案包必须是完整可复现的团队；任何缺失/下架/版本不符专家都使整包不可应用。
                raise Conflict(f"solution expert {expert_id!r} is unavailable or not published") from exc

        coordinator_id = payload.get("coordinator_template_id", "")
        if hidden_ids and (coordinator_id in hidden_ids or not experts):
            # 协调专家（或全部专家）对本企业不可见：方案无法在该企业应用，当作不存在。
            raise TemplateOutOfScope(f"solution package not visible: {solution_id}")

        return SolutionPackage(
            solution_id=entry.template_id,
            version=entry.version,
            display_name=entry.display_name,
            description=payload.get("description", ""),
            icon=payload.get("icon", ""),
            coordinator_template_id=payload.get("coordinator_template_id", ""),
            coordinator_instructions=payload.get("coordinator_instructions", ""),
            output_requirements=payload.get("output_requirements", ""),
            mode=payload.get("mode", "group"),
            orchestration_rules=payload.get("orchestration_rules", ""),
            recommended_capabilities=payload.get("recommended_capabilities", []),
            experts=experts,
            tags=payload.get("tags", []),
            hidden_expert_count=len(hidden_ids),
            hidden_experts=hidden_refs,
        )

    def list_published_expert_templates(self, *, tenant_id: str | None = None):
        """F06：Manager 列举可招募专家模板（只读，只返回 PUBLISHED 状态）。"""
        from shared.contracts.crosstier import ExpertTemplateDetail

        entries = self._repo.list(
            catalog_type=CatalogType.EXPERT_TEMPLATE, status=CatalogStatus.PUBLISHED
        )
        results: list[ExpertTemplateDetail] = []
        for entry in entries:
            if not self._visible_to(entry, tenant_id):
                continue
            payload = entry.payload or {}
            persona, recommended = self._backfill_expert(payload)
            results.append(
                ExpertTemplateDetail(
                    **_profile_projection(payload),
                    template_id=entry.template_id,
                    version=entry.version,
                    display_name=entry.display_name,
                    persona=persona,
                    recommended_config=recommended,
                    category=payload.get("category", ""),
                    avatar_url=avatar_url_for(entry.template_id, payload, pull=True),
                    avatar_version=avatar_version(payload),
                    system_prompt=payload.get("system_prompt", ""),
                    skill_ids=payload.get("skill_ids", []),
                    platform_skill_refs=payload.get("platform_skill_refs", []),
                    description=payload.get("description", ""),
                    initial_memories=payload.get("initial_memories", []),
                    sort_order=payload.get("sort_order", 0),
                )
            )
        return results

    def list_published_solution_packages(self, *, tenant_id: str | None = None):
        """F07：Manager 列举可应用行业方案包（只读，只返回 PUBLISHED 状态）。"""
        from shared.contracts.crosstier import SolutionPackage

        entries = self._repo.list(
            catalog_type=CatalogType.SOLUTION_TEMPLATE, status=CatalogStatus.PUBLISHED
        )
        results: list[SolutionPackage] = []
        for entry in entries:
            try:
                package = self.pull_solution_package(solution_id=entry.template_id, version=None, tenant_id=tenant_id)
                results.append(package)
            except Exception:  # noqa: BLE001
                # 跳过解析失败的方案包
                pass
        return results

    # ---- 发布范围：联想与预计可见企业数 ----

    def scope_options(self) -> dict:
        profiles = self._enterprises.list_profiles() if self._enterprises is not None else []
        industries = sorted({industry for industry, _ in profiles if industry})
        tags = sorted({tag for _, tags in profiles for tag in tags})
        return {"industries": industries, "tags": tags}

    def preview_scope(self, scope: VisibleScope) -> int:
        profiles = self._enterprises.list_profiles() if self._enterprises is not None else []
        return sum(1 for industry, tags in profiles if scope_allows(scope.model_dump(), industry=industry, tags=tags))

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
