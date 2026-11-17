"""行业文档生成：运营端服务（草稿状态机、资料、敏感项、审核、发布到目录）。

状态：draft → generating → ready_for_review → in_review → approved → published；任意可审状态可被 rejected，
除 generating 外都可 archived。生成本身由 `solution_authoring_jobs` 里的任务执行器完成，这里只负责入队。
所有状态判断都在仓储的草稿行锁内做（`update_draft` 的 decide 回调），并发请求不会越过闸门。
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import ValidationError

from shared.contracts.crosstier import RecommendedCapability
from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.envelope import ProblemFieldError
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import (
    Conflict,
    Forbidden,
    InvalidTransition,
    NotFound,
    RequestTooLarge,
    ServiceUnavailable,
    ValidationProblem,
)
from shared.solution_authoring.isolated_parse import parse_source_isolated
from shared.solution_authoring.orchestration import (
    OrchestrationRefError,
    rewrite_member_refs,
)
from shared.solution_authoring.parsing import SourceParseError
from shared.solution_authoring.schemas import GeneratedSolution
from shared.solution_authoring.sensitive_scan import (
    REDACTION_PLACEHOLDER,
    redact_solution,
)

from .catalog_schemas import (
    CatalogEntryResponse,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
)
from .solution_authoring_findings import assert_no_unresolved, reconcile_findings
from .solution_authoring_gates import (
    confirm_digest,
    evaluate_gates,
    required_confirmations,
)
from .solution_authoring_models import ModelConfigResolver
from .solution_authoring_repository import (
    DraftChange,
    DraftRow,
    FindingRow,
    JobRow,
    SolutionAuthoringRepository,
    SourceRow,
)
from .solution_authoring_schemas import (
    DraftCreate,
    DraftDetailOut,
    DraftOut,
    DraftSummaryOut,
    FindingResolution,
    JobOut,
    PackageUpdate,
    SourceOut,
)
from .solution_authoring_skills import (
    NOT_IN_CATALOG,
    VERSION_MISMATCH,
    SkillCatalogLoader,
    has_skill_refs,
    unresolved_skills,
)
from .solution_authoring_storage import SourceFileStore, sha256_hex

EDITABLE_STATUSES = ("draft", "ready_for_review", "rejected")  # 可增删资料、可发起生成
REVIEWED_STATUSES = ("approved", "published")  # 只有审核人能归档
CONTENT_STATUSES = ("ready_for_review", "rejected")  # 可编辑正文、处理敏感项、提交审核
MAX_SOURCES = 20
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024
MAX_IDEMPOTENCY_KEY_CHARS = 200

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


class CatalogPublisher(Protocol):
    """发布所需的目录能力（`CatalogService` 满足）。"""

    def get_entry(self, catalog_type: CatalogType, template_id: str) -> CatalogEntryResponse: ...
    def register_expert_template(self, req: RegisterExpertTemplateRequest) -> CatalogEntryResponse: ...
    def register_solution_template(self, req: RegisterSolutionTemplateRequest) -> CatalogEntryResponse: ...
    def publish_template(
        self, catalog_type: CatalogType, template_id: str, req: PublishTemplateRequest,
    ) -> CatalogEntryResponse: ...


def _file_name(raw: str | None) -> str:
    """只取文件名本身（去掉客户端带来的路径与控制字符）。它只用于展示和判断类型，从不进入存储路径。"""
    name = _CONTROL_RE.sub("", (raw or "").replace("\\", "/").rsplit("/", 1)[-1]).strip()
    return name[-255:] or "untitled"


def _model_ref(draft: DraftRow) -> PlatformModelRef:
    return PlatformModelRef(provider_id=draft.model_provider_id, model_id=draft.model_id)


def _require_content(draft: DraftRow, action: str) -> dict[str, Any]:
    if draft.status not in CONTENT_STATUSES or draft.package is None:
        raise InvalidTransition(f"{action} is not available while the draft is {draft.status}")
    return draft.package


def publish_plan(draft: DraftRow) -> dict[str, Any]:
    """目录 ID 由草稿与内容确定性推出：发布中途失败后重试会落到同一批目录项上，不会重复注册。"""
    canonical = json.dumps(draft.package, ensure_ascii=False, sort_keys=True)
    seed = f"{draft.draft_id}\x00{draft.model_provider_id}\x00{draft.model_id}\x00{canonical}"
    prefix = f"sa-{hashlib.sha256(seed.encode()).hexdigest()[:12]}"
    experts = (draft.package or {}).get("experts", [])
    return {
        "solution_id": prefix,
        "expert_template_ids": {item["key"]: f"{prefix}-{item['key'].replace('_', '-')}" for item in experts},
    }


class SolutionAuthoringService:
    def __init__(
        self,
        repo: SolutionAuthoringRepository,
        store: SourceFileStore,
        models: ModelConfigResolver,
        catalog: Callable[[], CatalogPublisher],
        clock: Callable[[], datetime] | None = None,
        skill_catalog: SkillCatalogLoader | None = None,
    ):
        self._repo = repo
        self._store = store
        self._models = models
        self._catalog = catalog
        self._clock = clock or (lambda: datetime.now(UTC))
        # 平台已发布 skill 目录（与生成时同一口径）；未配置视为空目录。
        self._skill_catalog = skill_catalog or list

    # ---- 草稿 ----

    def create_draft(self, actor_id: str, body: DraftCreate) -> DraftOut:
        self._models.check(body.platform_model_ref, need_images=body.image_recognition == "vision")
        now = self._clock()
        row = DraftRow(
            draft_id=str(uuid.uuid4()), title=body.title,
            model_provider_id=body.platform_model_ref.provider_id, model_id=body.platform_model_ref.model_id,
            created_by=actor_id, updated_by=actor_id, created_at=now, updated_at=now,
            image_recognition=body.image_recognition, supplement=body.supplement.strip(), solution_mode=body.solution_mode,
        )
        return DraftOut.of(self._repo.create_draft(row))

    def list_drafts(self) -> list[DraftSummaryOut]:
        counts = self._repo.count_sources_by_draft()
        open_counts = self._repo.count_open_findings_by_draft()
        return [
            DraftSummaryOut.summarize(row, job, counts.get(row.draft_id, 0), open_counts.get(row.draft_id, 0))
            for row, job in self._repo.list_drafts_with_latest_job()
        ]

    def cancel_generation(self, draft_id: str, actor_id: str) -> DraftDetailOut:
        """取消进行中的生成；没有进行中的任务时原样返回（幂等）。"""
        self._repo.cancel_job(draft_id, actor_id)
        return self.get_draft(draft_id)

    def get_draft(self, draft_id: str) -> DraftDetailOut:
        row = self._repo.get_draft(draft_id)
        return DraftDetailOut.assemble(
            row, sources=self._repo.list_sources(draft_id), findings=self._repo.list_findings(draft_id),
            events=self._repo.list_events(draft_id), job=self._repo.latest_job(draft_id),
        )

    def archive_draft(self, draft_id: str, actor_id: str, *, can_archive_reviewed: bool = False) -> None:
        """归档并删除资料原件。已发布的方案仍留在目录里，不受影响。

        `can_archive_reviewed`：调用方是否有审核权（system_admin）；没有时不能归档已审核通过 / 已发布的草稿。
        """

        def decide(draft: DraftRow, _findings: list[FindingRow]) -> DraftChange:
            if draft.status == "generating":
                raise InvalidTransition("a draft cannot be archived while it is generating")
            if draft.status == "archived":
                return DraftChange()
            # 审核通过 / 已开始发布的草稿会删掉审计依据（原件），只允许审核人归档。
            if not can_archive_reviewed and (draft.status in REVIEWED_STATUSES or draft.publish_state):
                raise Forbidden("only a system_admin can archive an approved or published draft")
            return DraftChange(changes={"status": "archived"}, event=("archived", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        # 先删文件再删行：删文件失败时行还在，重试归档（已归档分支）会再清一遍，不留孤儿文件。
        self._store.delete_draft(draft_id)
        self._repo.purge_sources(draft_id)

    # ---- 资料 ----

    def add_source(self, draft_id: str, actor_id: str, file_name: str | None, data: bytes) -> SourceOut:
        """校验并保存一份资料。上传时就完整解析一遍：不支持或损坏的文件当场拒绝，而不是等到生成时才失败。"""
        name = _file_name(file_name)
        if len(data) > MAX_SOURCE_BYTES:
            raise RequestTooLarge(f"a source document must not exceed {MAX_SOURCE_BYTES // (1024 * 1024)} MB")
        draft = self._repo.get_draft(draft_id)
        if draft.status not in EDITABLE_STATUSES:
            raise InvalidTransition(f"sources cannot be changed while the draft is {draft.status}")
        try:
            # 不可信文件在子进程里解析（超时 / 资源上限），解析库出问题不拖垮 API 进程。
            parsed = parse_source_isolated("s0", name, data)
        except SourceParseError as exc:
            raise ValidationProblem(
                str(exc), errors=[ProblemFieldError(loc=["body", "file"], message=str(exc), type=exc.code)],
            ) from exc
        source_id = str(uuid.uuid4())
        key = self._store.put(draft_id, source_id, data)
        row = SourceRow(
            source_id=source_id, draft_id=draft_id, file_name=name, size_bytes=len(data), sha256=sha256_hex(data),
            storage_key=key, created_by=actor_id, created_at=self._clock(), status="parsed",
            chunk_count=len(parsed.chunks), image_count=len(parsed.images), warnings=list(parsed.warnings),
        )
        try:
            stored = self._repo.add_source(
                row, allowed_statuses=EDITABLE_STATUSES, max_sources=MAX_SOURCES, max_total_bytes=MAX_TOTAL_BYTES,
            )
        except BaseException:
            self._store.delete(key)
            raise
        return SourceOut.of(stored)

    def remove_source(self, draft_id: str, source_id: str) -> None:
        row = self._repo.remove_source(draft_id, source_id, allowed_statuses=EDITABLE_STATUSES)
        self._store.delete(row.storage_key)

    # ---- 生成 ----

    def request_generation(self, draft_id: str, actor_id: str, idempotency_key: str) -> tuple[JobOut, bool]:
        key = idempotency_key.strip()
        if not key or len(key) > MAX_IDEMPOTENCY_KEY_CHARS:
            raise ValidationProblem(f"Idempotency-Key must be 1 to {MAX_IDEMPOTENCY_KEY_CHARS} characters")
        draft = self._repo.get_draft(draft_id)
        self._models.ensure_ready()
        self._models.check(_model_ref(draft), need_images=draft.image_recognition == "vision")
        job = JobRow(
            job_id=str(uuid.uuid4()), draft_id=draft_id, created_by=actor_id, created_at=self._clock(), idempotency_key=key,
        )
        queued, created = self._repo.enqueue_job(job, allowed_statuses=EDITABLE_STATUSES)
        return JobOut.of(queued), created

    def get_job(self, draft_id: str, job_id: str) -> JobOut:
        return JobOut.of(self._repo.get_job(draft_id, job_id))

    # ---- 正文编辑与敏感项 ----

    def update_package(self, draft_id: str, actor_id: str, body: PackageUpdate) -> DraftDetailOut:
        package = body.package.model_dump(mode="json")
        cited = body.package.evidence_chunk_ids()
        self._check_skill_refs(package)
        now = self._clock()

        def decide(draft: DraftRow, findings: list[FindingRow]) -> DraftChange:
            _require_content(draft, "editing")
            if cited - set(draft.evidence_sources):
                raise ValidationProblem("evidence may only cite source excerpts that belong to this draft")
            updates, added = reconcile_findings(package, findings, draft_id=draft_id, actor_id=actor_id, now=now)
            return DraftChange(
                changes={"package": package}, finding_updates=updates, new_findings=added, event=("package_edited", ""),
            )

        self._repo.update_draft(draft_id, actor_id, decide, expected_version=body.version)
        return self.get_draft(draft_id)

    def _check_skill_refs(self, package: dict[str, Any]) -> None:
        """手动保存也按平台已发布目录校验全部 skill 引用：选择后被下架、改版或手填的引用不落库。

        校验整份正文（不只本次改动的分区），这样已失效的引用在下一次保存时就会暴露，而不是等到发布前人工发现。
        """
        if not has_skill_refs(package):
            return
        try:
            catalog = list(self._skill_catalog())
        except Exception as exc:  # noqa: BLE001 — 目录读不到时不放行未经校验的引用
            raise ServiceUnavailable("平台技能目录暂时读不到，请稍后再保存") from exc
        bad = unresolved_skills(package, catalog)
        if bad:
            reasons = {NOT_IN_CATALOG: "平台目录里没有或已下架", VERSION_MISMATCH: "版本或内容与平台已发布的不一致"}
            listed = "；".join(f"{where}（{reasons[code]}）" for where, code in bad)
            raise ValidationProblem(f"有 skill 不是平台已发布的版本：{listed}。请在「能力清单」里移除，或换成已发布版本后再保存。")

    def resolve_finding(self, draft_id: str, finding_id: str, actor_id: str, resolution: FindingResolution) -> DraftDetailOut:
        now = self._clock()
        resolved = {"resolved_by": actor_id, "resolved_at": now}

        def decide(draft: DraftRow, findings: list[FindingRow]) -> DraftChange:
            current = _require_content(draft, "resolving findings")
            row = next((item for item in findings if item.finding_id == finding_id), None)
            if row is None:
                raise NotFound("finding not found")
            if row.status != "open":
                raise Conflict("this finding has already been resolved")
            if (resolution == "acknowledge") != (not row.field_path):
                raise ValidationProblem(
                    "an item outside the draft content can only be acknowledged" if not row.field_path
                    else "an item inside the draft content must be redacted, removed or accepted as public",
                )
            if resolution == "acknowledge":
                return DraftChange(
                    finding_updates={finding_id: {"status": "acknowledged", **resolved}}, event=("finding_acknowledged", row.kind),
                )
            if resolution == "accept_public":
                return DraftChange(
                    finding_updates={finding_id: {"status": "accepted_public", **resolved}},
                    event=("finding_accepted_public", row.kind),
                )
            package = copy.deepcopy(current)
            redact_solution(package, row.excerpt, REDACTION_PLACEHOLDER if resolution == "redact" else "")
            try:
                package = GeneratedSolution.model_validate(package).model_dump(mode="json")
            except ValidationError as exc:
                raise ValidationProblem("removing this content would leave a required field empty; edit the draft instead") from exc
            status = "redacted" if resolution == "redact" else "removed"
            others = [item for item in findings if item.finding_id != finding_id]
            updates, added = reconcile_findings(package, others, draft_id=draft_id, actor_id=actor_id, now=now)
            updates[finding_id] = {"status": status, **resolved}
            return DraftChange(
                changes={"package": package}, finding_updates=updates, new_findings=added, event=(f"finding_{status}", row.kind),
            )

        self._repo.update_draft(draft_id, actor_id, decide)
        return self.get_draft(draft_id)

    # ---- 审核 ----

    def submit_review(self, draft_id: str, actor_id: str) -> DraftDetailOut:
        def decide(draft: DraftRow, findings: list[FindingRow]) -> DraftChange:
            package = _require_content(draft, "submitting for review")
            assert_no_unresolved(package, findings)
            blocked = next((gate for gate in evaluate_gates(package, draft.confirmations, open_findings=0) if not gate.ok), None)
            if blocked is not None:
                raise Conflict(blocked.message)
            return DraftChange(changes={"status": "in_review", "review_note": ""}, event=("submitted_for_review", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        return self.get_draft(draft_id)

    def confirm(self, draft_id: str, actor_id: str, item: str) -> DraftDetailOut:
        """运营确认群主 / 编排规则 / 能力清单。确认记录的是当时内容的摘要，之后内容被改动则自动失效。"""
        now = self._clock()

        def decide(draft: DraftRow, _findings: list[FindingRow]) -> DraftChange:
            package = _require_content(draft, "confirming")
            if item not in required_confirmations(package):
                raise ValidationProblem(f"{item} does not need to be confirmed for this draft")
            if item == "rules" and not str(package.get("orchestration_rules", "")).strip():
                raise ValidationProblem("orchestration rules are required for a group solution")
            record = {"by": actor_id, "at": now.isoformat(), "digest": confirm_digest(package, item)}
            return DraftChange(changes={"confirmations": {**draft.confirmations, item: record}}, event=(f"confirmed_{item}", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        return self.get_draft(draft_id)

    def approve(self, draft_id: str, actor_id: str, note: str) -> DraftDetailOut:
        def decide(draft: DraftRow, findings: list[FindingRow]) -> DraftChange:
            if draft.status != "in_review" or draft.package is None:
                raise InvalidTransition(f"only a draft in review can be approved (current: {draft.status})")
            assert_no_unresolved(draft.package, findings)
            return DraftChange(changes={"status": "approved", "review_note": note.strip()}, event=("approved", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        return self.get_draft(draft_id)

    def reject(self, draft_id: str, actor_id: str, note: str) -> DraftDetailOut:
        reason = note.strip()
        if not reason:
            raise ValidationProblem("a reason is required when rejecting a draft")

        def decide(draft: DraftRow, _findings: list[FindingRow]) -> DraftChange:
            if draft.status not in ("in_review", "approved"):
                raise InvalidTransition(f"only a draft in review or approved can be rejected (current: {draft.status})")
            if draft.publish_state:
                # 发布已开始：部分专家可能已经对企业可见。驳回会让它们失去归属，只能重试发布把它完成。
                raise InvalidTransition("publishing has already started for this draft; retry the publish instead of rejecting it")
            # 理由可能引用正文，只存在草稿上，不进审计事件摘要。
            return DraftChange(changes={"status": "rejected", "review_note": reason}, event=("rejected", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        return self.get_draft(draft_id)

    # ---- 发布 ----

    def publish(self, draft_id: str, actor_id: str) -> DraftDetailOut:
        """把已通过的草稿写入目录并发布：先全部注册（草稿态，不外溢），再逐个发布，最后发布方案。

        每一步都先查目录再动手，所以中途失败后原样重试即可；草稿在全部完成后才变为 published。
        """

        def start(draft: DraftRow, findings: list[FindingRow]) -> DraftChange:
            if draft.status != "approved" or draft.package is None:
                raise InvalidTransition(f"only an approved draft can be published (current: {draft.status})")
            assert_no_unresolved(draft.package, findings)
            return DraftChange(changes={"publish_state": publish_plan(draft)}, event=("publish_started", ""))

        draft = self._repo.update_draft(draft_id, actor_id, start)
        plan = draft.publish_state
        solution_id: str = plan["solution_id"]
        expert_ids: dict[str, str] = plan["expert_template_ids"]
        package = GeneratedSolution.model_validate(draft.package)
        catalog = self._catalog()
        # 草稿里的成员引用是专家 key，目录里换成专家模板 ID；Manager 应用时再换成员工 ID。
        # 先换算再向目录登记任何东西：换不出来就明确失败，不留下半个已登记的方案。
        try:
            catalog_rules = rewrite_member_refs(package.orchestration_rules, expert_ids)
        except OrchestrationRefError as exc:
            raise Conflict("该草稿的群聊编排规则引用了不在专家名单里的成员，无法发布；请回到草稿修正编排规则后重新提交审核") from exc

        for expert in package.experts:
            request = RegisterExpertTemplateRequest(
                template_id=expert_ids[expert.key], display_name=expert.display_name, category=expert.category,
                system_prompt=expert.system_prompt, description=expert.description,
            )
            self._ensure_registered(catalog, CatalogType.EXPERT_TEMPLATE, request.template_id or "", lambda r=request: catalog.register_expert_template(r))
        solution = RegisterSolutionTemplateRequest(
            solution_id=solution_id, display_name=package.display_name, description=package.description,
            expert_template_ids=[expert_ids[expert.key] for expert in package.experts],
            coordinator_template_id=expert_ids[package.coordinator_key],
            coordinator_instructions=package.coordinator_instructions,
            output_requirements=package.output_requirements, tags=package.tags,
            mode=package.mode, recommended_capabilities=_recommended_capabilities(package),
            orchestration_rules=catalog_rules,
        )
        self._ensure_registered(catalog, CatalogType.SOLUTION_TEMPLATE, solution_id, lambda: catalog.register_solution_template(solution))
        for template_id in expert_ids.values():
            self._ensure_published(catalog, CatalogType.EXPERT_TEMPLATE, template_id)
        self._ensure_published(catalog, CatalogType.SOLUTION_TEMPLATE, solution_id)

        def finish(current: DraftRow, _findings: list[FindingRow]) -> DraftChange:
            if current.status != "approved" or current.publish_state != plan:
                raise InvalidTransition("the draft changed while it was being published; reload and retry")
            return DraftChange(changes={"status": "published", "published_solution_id": solution_id}, event=("published", solution_id))

        self._repo.update_draft(draft_id, actor_id, finish)
        return self.get_draft(draft_id)

    @staticmethod
    def _ensure_registered(
        catalog: CatalogPublisher, catalog_type: CatalogType, template_id: str, register: Callable[[], CatalogEntryResponse],
    ) -> None:
        try:
            catalog.get_entry(catalog_type, template_id)
        except NotFound:
            register()

    @staticmethod
    def _ensure_published(catalog: CatalogPublisher, catalog_type: CatalogType, template_id: str) -> None:
        if catalog.get_entry(catalog_type, template_id).status != CatalogStatus.PUBLISHED:
            catalog.publish_template(catalog_type, template_id, PublishTemplateRequest())


def _recommended_capabilities(package: GeneratedSolution) -> list[RecommendedCapability]:
    """把各专家的 skill / MCP 声明合并成方案级的推荐清单（去重、保序）。只是提示，不绑定到专家。"""
    seen: dict[tuple[str, str], RecommendedCapability] = {}
    for expert in package.experts:
        for skill in expert.skills:
            seen.setdefault(("skill", skill.skill_id), RecommendedCapability(
                kind="skill", ref=skill.skill_id, display_name=skill.skill_id, purpose=skill.reason,
            ))
        for mcp in expert.mcps:
            seen.setdefault(("mcp", mcp.key), RecommendedCapability(
                kind="mcp", ref=mcp.key, display_name=mcp.display_name, purpose=mcp.purpose,
            ))
    return list(seen.values())[:24]
