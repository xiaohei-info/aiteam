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

from shared.contracts.enums import CatalogStatus, CatalogType
from shared.contracts.envelope import ProblemFieldError
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import Conflict, InvalidTransition, NotFound, RequestTooLarge, ValidationProblem
from shared.solution_authoring.parsing import SourceParseError, parse_source
from shared.solution_authoring.schemas import GeneratedSolution
from shared.solution_authoring.sensitive_scan import REDACTION_PLACEHOLDER, redact_solution

from .catalog_schemas import (
    CatalogEntryResponse,
    PublishTemplateRequest,
    RegisterExpertTemplateRequest,
    RegisterSolutionTemplateRequest,
)
from .solution_authoring_findings import assert_no_unresolved, reconcile_findings
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
    FindingResolution,
    JobOut,
    PackageUpdate,
    SourceOut,
)
from .solution_authoring_storage import SourceFileStore, sha256_hex

EDITABLE_STATUSES = ("draft", "ready_for_review", "rejected")  # 可增删资料、可发起生成
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
    ):
        self._repo = repo
        self._store = store
        self._models = models
        self._catalog = catalog
        self._clock = clock or (lambda: datetime.now(UTC))

    # ---- 草稿 ----

    def create_draft(self, actor_id: str, body: DraftCreate) -> DraftOut:
        self._models.check(body.platform_model_ref, need_images=body.image_recognition == "vision")
        now = self._clock()
        row = DraftRow(
            draft_id=str(uuid.uuid4()), title=body.title,
            model_provider_id=body.platform_model_ref.provider_id, model_id=body.platform_model_ref.model_id,
            created_by=actor_id, updated_by=actor_id, created_at=now, updated_at=now,
            image_recognition=body.image_recognition, supplement=body.supplement.strip(),
        )
        return DraftOut.of(self._repo.create_draft(row))

    def list_drafts(self) -> list[DraftOut]:
        return [DraftOut.of(row) for row in self._repo.list_drafts()]

    def get_draft(self, draft_id: str) -> DraftDetailOut:
        row = self._repo.get_draft(draft_id)
        return DraftDetailOut.assemble(
            row, sources=self._repo.list_sources(draft_id), findings=self._repo.list_findings(draft_id),
            events=self._repo.list_events(draft_id), job=self._repo.latest_job(draft_id),
        )

    def archive_draft(self, draft_id: str, actor_id: str) -> None:
        """归档并删除资料原件。已发布的方案仍留在目录里，不受影响。"""

        def decide(draft: DraftRow, _findings: list[FindingRow]) -> DraftChange:
            if draft.status == "generating":
                raise InvalidTransition("a draft cannot be archived while it is generating")
            if draft.status == "archived":
                return DraftChange()
            return DraftChange(changes={"status": "archived"}, event=("archived", ""))

        self._repo.update_draft(draft_id, actor_id, decide)
        self._repo.purge_sources(draft_id)
        self._store.delete_draft(draft_id)

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
            parsed = parse_source("s0", name, data)
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
            assert_no_unresolved(_require_content(draft, "submitting for review"), findings)
            return DraftChange(changes={"status": "in_review", "review_note": ""}, event=("submitted_for_review", ""))

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

        for expert in package.experts:
            request = RegisterExpertTemplateRequest(
                template_id=expert_ids[expert.key], display_name=expert.display_name, category=expert.category,
                system_prompt=expert.system_prompt, description=expert.description, platform_model_ref=_model_ref(draft),
            )
            self._ensure_registered(catalog, CatalogType.EXPERT_TEMPLATE, request.template_id or "", lambda r=request: catalog.register_expert_template(r))
        solution = RegisterSolutionTemplateRequest(
            solution_id=solution_id, display_name=package.display_name, description=package.description,
            expert_template_ids=[expert_ids[expert.key] for expert in package.experts],
            coordinator_template_id=expert_ids[package.coordinator_key],
            coordinator_instructions=package.coordinator_instructions,
            output_requirements=package.output_requirements, tags=package.tags,
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
