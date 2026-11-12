"""行业文档生成：运营端服务与任务执行器（内存仓储 + 假 runner；最后一组用真实 Node worker 的假模型）。"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest

from operation_service.catalog_gateway import CatalogManagerGateway
from operation_service.catalog_repository import CatalogRepository
from operation_service.catalog_service import CatalogService
from operation_service.solution_authoring_jobs import (
    MAX_ATTEMPTS,
    GenerationJobExecutor,
)
from operation_service.solution_authoring_repository import (
    MemorySolutionAuthoringRepository,
)
from operation_service.solution_authoring_schemas import DraftCreate, PackageUpdate
from operation_service.solution_authoring_service import SolutionAuthoringService
from operation_service.solution_authoring_storage import (
    SourceFileStore,
    SourceStorageError,
)
from shared.contracts.enums import CatalogStatus, CatalogType
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
from shared.solution_authoring.runner import (
    FauxModelConfig,
    GenerateOutcome,
    PiWorkerRunner,
    RecognizeOutcome,
    WorkerError,
)
from shared.solution_authoring.schemas import (
    AgentFinding,
    AuthoringResult,
    AuthoringUsage,
    GeneratedSolution,
    RecognizedBlock,
    RecognizedImage,
)
from tests.shared.solution_authoring_fixtures import docx_bytes, png_bytes, real_worker

PHONE = "13800001111"
EMAIL = "zhang.san@example.com"
MODEL_REF = PlatformModelRef(provider_id="provider-1", model_id="model-1")
MANUAL = "质量手册第一章：来料检验流程。\n\n第二章：不合格品处理与追溯要求。".encode()


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 12, 8, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        self.now += timedelta(milliseconds=1)
        return self.now


class Models:
    uses_faux_model = True

    def __init__(self) -> None:
        self.checks: list[tuple[str, bool]] = []
        self.ready = True
        self.input: list[str] = ["text", "image"]

    def check(self, ref, *, need_images):
        self.checks.append((ref.model_id, need_images))
        if ref.model_id == "unpublished":
            raise Conflict("platform provider/model is not published")

    def ensure_ready(self):
        if not self.ready:
            raise ServiceUnavailable("solution generation is not configured")

    def resolve(self, ref):
        return FauxModelConfig(input=self.input)  # type: ignore[arg-type]


def _solution(chunk_id: str, *, extra: str = f"联系电话 {PHONE}。") -> dict:
    return {
        "display_name": "来料质检方案", "description": "覆盖来料检验与不合格品处理。", "tags": ["质检"],
        "coordinator_key": "lead", "coordinator_instructions": "先拆解再分派。", "output_requirements": "列出依据。",
        "experts": [
            {"key": "lead", "display_name": "质检协调专家", "category": "质量管理", "description": "统筹质检任务。",
             "system_prompt": f"你是质检协调专家。{extra}", "evidence": [{"chunk_id": chunk_id, "quote": "来料检验"}]},
            {"key": "inspector", "display_name": "检验专家", "category": "质量管理", "description": "执行来料检验。",
             "system_prompt": "你是检验专家，按流程检验来料。", "evidence": [{"chunk_id": chunk_id}]},
        ],
        "evidence": [{"chunk_id": chunk_id}],
    }


class Runner:
    """假 runner：记录收到的片段；可指定生成失败码与识别失败的图片。"""

    def __init__(self) -> None:
        self.generate_error: WorkerError | None = None
        self.unreadable: set[str] = set()
        self.chunks: list = []
        self.prompts: list[tuple[str, str]] = []
        self.before_return = lambda: None
        self.closed = False

    def generate(self, chunks, *, model, budget, system_prompt, task_prompt):
        self.chunks = list(chunks)
        self.prompts.append((system_prompt, task_prompt))
        if self.generate_error is not None:
            raise self.generate_error
        first = chunks[0]
        result = AuthoringResult(
            solution=GeneratedSolution.model_validate(_solution(first.chunk_id)),
            findings=[AgentFinding(kind="company", chunk_id=first.chunk_id, excerpt="华东某客户", note="资料中出现客户名称")],
        )
        self.before_return()
        return GenerateOutcome(result=result, usage=AuthoringUsage(input_tokens=90, output_tokens=10, total_tokens=100, turns=3, tool_calls=3))

    def recognize(self, images, *, model, budget, system_prompt, task_prompt):
        recognized = [
            RecognizedImage(image_id=image.image_id, status="unrecognized", reason="unreadable") if image.image_id in self.unreadable
            else RecognizedImage(image_id=image.image_id, status="recognized", blocks=[RecognizedBlock(text="图中流程：抽检", confidence=0.4)])
            for image in images
        ]
        return RecognizeOutcome(images=recognized, usage=AuthoringUsage(total_tokens=20, turns=len(images), tool_calls=len(images)))

    def close(self):
        self.closed = True


class Gateway(CatalogManagerGateway):
    def __init__(self) -> None:
        self.notifications: list[tuple[str, str]] = []

    def notify_catalog_release(self, notify, *, idempotency_key):
        self.notifications.append((notify.template_id, notify.action))


class Env:
    def __init__(self, tmp_path):
        self.clock = Clock()
        self.repo = MemorySolutionAuthoringRepository(self.clock)
        self.store = SourceFileStore(tmp_path / "sources")
        self.models = Models()
        self.runner = Runner()
        self.gateway = Gateway()
        providers = type("Providers", (), {"validate_model_ref": lambda self, ref, require_published=False: ref})()
        self.catalog = CatalogService(CatalogRepository(), self.gateway, platform_providers=providers)
        self.service = SolutionAuthoringService(self.repo, self.store, self.models, lambda: self.catalog, self.clock)
        self.executor = GenerationJobExecutor(self.repo, self.store, self.models, self.runner, owner="w1", clock=self.clock)

    def draft(self, **overrides) -> str:
        body = DraftCreate(**{"title": " 质检方案 ", "platform_model_ref": MODEL_REF, **overrides})
        return self.service.create_draft("op1", body).draft_id

    def generated(self, **overrides) -> str:
        draft_id = self.draft(**overrides)
        self.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
        self.service.request_generation(draft_id, "op1", "k1")
        assert self.executor.run_once() is True
        return draft_id

    def files(self) -> list[str]:
        return sorted(path.name for path in self.store.root.rglob("*") if path.is_file())


@pytest.fixture
def env(tmp_path) -> Env:
    return Env(tmp_path)


def _open(detail) -> dict[str, str]:
    return {item.kind: item.finding_id for item in detail.findings if item.status == "open"}


def _resolve_all(env: Env, draft_id: str) -> None:
    for item in env.service.get_draft(draft_id).findings:
        if item.status == "open":
            env.service.resolve_finding(draft_id, item.finding_id, "op1", "redact" if item.field_path else "acknowledge")


# ---- 草稿与资料 ----

def test_create_checks_the_model_and_normalizes_input(env):
    draft_id = env.draft(image_recognition="vision", supplement="  侧重来料检验  ")
    detail = env.service.get_draft(draft_id)
    assert (detail.title, detail.status, detail.supplement, detail.image_recognition) == ("质检方案", "draft", "侧重来料检验", "vision")
    assert detail.platform_model_ref == MODEL_REF and detail.package is None and detail.latest_job is None
    assert env.models.checks == [("model-1", True)]
    with pytest.raises(Conflict):
        env.draft(platform_model_ref=PlatformModelRef(provider_id="provider-1", model_id="unpublished"))
    assert [item.draft_id for item in env.service.list_drafts()] == [draft_id]


def test_upload_parses_immediately_and_never_uses_the_client_file_name_as_a_path(env):
    draft_id = env.draft()
    source = env.service.add_source(draft_id, "op1", "..\\..\\etc/质量\x00手册.md", MANUAL)
    assert (source.file_name, source.status, source.image_count, source.size_bytes) == ("质量手册.md", "parsed", 0, len(MANUAL))
    assert source.chunk_count >= 1
    assert env.files() == [source.source_id]
    stored = env.repo.list_sources(draft_id)[0]
    assert stored.storage_key == f"{draft_id}/{source.source_id}"
    assert env.store.read(stored.storage_key, stored.sha256) == MANUAL


def test_upload_rejections_leave_no_file_behind(env):
    draft_id = env.draft()
    with pytest.raises(ValidationProblem) as unsupported:
        env.service.add_source(draft_id, "op1", "方案.exe", b"MZ")
    assert unsupported.value.errors and unsupported.value.errors[0].type == "unsupported_format"
    with pytest.raises(ValidationProblem) as legacy:
        env.service.add_source(draft_id, "op1", "旧版.doc", b"\xd0\xcf\x11\xe0")
    assert legacy.value.errors and legacy.value.errors[0].type == "legacy_format"
    with pytest.raises(ValidationProblem):
        env.service.add_source(draft_id, "op1", "坏的.docx", b"not a zip")
    with pytest.raises(RequestTooLarge):
        env.service.add_source(draft_id, "op1", "大.txt", b"x" * (20 * 1024 * 1024 + 1))
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    with pytest.raises(Conflict):
        env.service.add_source(draft_id, "op1", "同一份.md", MANUAL)
    with pytest.raises(NotFound):
        env.service.add_source("00000000-0000-4000-8000-000000000000", "op1", "a.md", MANUAL)
    assert len(env.files()) == 1 and len(env.service.get_draft(draft_id).sources) == 1


def test_remove_source_deletes_the_file(env):
    draft_id = env.draft()
    source = env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.remove_source(draft_id, source.source_id)
    assert env.files() == [] and env.service.get_draft(draft_id).sources == []


# ---- 发起生成 ----

def test_generation_request_is_gated_and_idempotent(env):
    draft_id = env.draft()
    with pytest.raises(ValidationProblem):
        env.service.request_generation(draft_id, "op1", "k1")
    with pytest.raises(ValidationProblem):
        env.service.request_generation(draft_id, "op1", "   ")
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.models.ready = False
    with pytest.raises(ServiceUnavailable):
        env.service.request_generation(draft_id, "op1", "k1")
    env.models.ready = True

    job, created = env.service.request_generation(draft_id, "op1", "k1")
    again, created_again = env.service.request_generation(draft_id, "op2", "k1")
    assert (created, created_again, again.job_id, job.status) == (True, False, job.job_id, "queued")
    with pytest.raises(Conflict):
        env.service.request_generation(draft_id, "op1", "k2")
    assert env.service.get_draft(draft_id).status == "generating"
    assert env.service.get_job(draft_id, job.job_id).status == "queued"
    with pytest.raises(InvalidTransition):
        env.service.add_source(draft_id, "op1", "另一份.md", b"more")


# ---- 任务执行 ----

def test_a_successful_job_writes_content_evidence_and_findings_together(env, caplog):
    caplog.set_level(logging.DEBUG)
    draft_id = env.generated(supplement="侧重来料检验")
    detail = env.service.get_draft(draft_id)

    assert detail.status == "ready_for_review" and detail.package is not None
    assert [expert.key for expert in detail.package.experts] == ["lead", "inspector"]
    assert (detail.prompt_version, detail.usage["total_tokens"]) == ("v1", 100)
    assert detail.latest_job is not None and (detail.latest_job.status, detail.latest_job.attempt) == ("succeeded", 1)
    chunk_id = env.runner.chunks[0].chunk_id
    assert list(detail.evidence_sources) == [chunk_id] and chunk_id.startswith("s1-c")
    assert detail.evidence_sources[chunk_id].source_name == "质量手册.md" and "来料检验" in detail.evidence_sources[chunk_id].excerpt

    by_kind = {item.kind: item for item in detail.findings}
    assert set(by_kind) == {"phone", "company"} and detail.open_finding_count == 2
    assert (by_kind["phone"].origin, by_kind["phone"].field_path, by_kind["phone"].masked) == ("rule", "experts[0].system_prompt", "1********1")
    assert (by_kind["company"].origin, by_kind["company"].field_path) == ("agent", "")
    assert by_kind["company"].locator.startswith("质量手册.md · ")
    # 接口只给脱敏片段；补充说明进任务提示而不是系统提示。
    assert PHONE not in "".join(item.model_dump_json() for item in detail.findings)
    system_prompt, task_prompt = env.runner.prompts[0]
    assert "侧重来料检验" in task_prompt and "侧重来料检验" not in system_prompt
    # 日志与审计事件不含文档正文和命中的敏感内容。
    assert "来料检验" not in caplog.text and PHONE not in caplog.text
    assert all(PHONE not in event.summary and "来料" not in event.summary for event in detail.events)
    assert [event.action for event in detail.events] == ["created", "generation_requested", "generation_succeeded"]
    assert env.executor.run_once() is False


def test_a_failed_job_leaves_no_half_finished_draft(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    env.runner.generate_error = WorkerError("budget_exceeded", "exceeded 60 turns", AuthoringUsage(total_tokens=77, turns=60))
    assert env.executor.run_once() is True

    detail = env.service.get_draft(draft_id)
    assert (detail.status, detail.package, detail.findings) == ("draft", None, [])
    assert detail.latest_job is not None
    assert (detail.latest_job.status, detail.latest_job.error_code, detail.latest_job.error_message) == ("failed", "budget_exceeded", "exceeded 60 turns")
    assert detail.latest_job.usage["total_tokens"] == 77

    env.runner.generate_error = None
    env.service.request_generation(draft_id, "op1", "k2")
    assert env.executor.run_once() is True
    assert env.service.get_draft(draft_id).status == "ready_for_review"


def test_regeneration_replaces_content_and_findings(env):
    draft_id = env.generated()
    _resolve_all(env, draft_id)
    assert env.service.get_draft(draft_id).open_finding_count == 0
    env.service.request_generation(draft_id, "op1", "k2")
    assert env.executor.run_once() is True
    detail = env.service.get_draft(draft_id)
    assert detail.open_finding_count == 2 and len(detail.findings) == 2
    assert detail.package is not None and PHONE in detail.package.experts[0].system_prompt


def test_missing_or_tampered_source_files_fail_the_job(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    stored = env.repo.list_sources(draft_id)[0]
    (env.store.root / stored.storage_key).write_bytes(b"tampered")
    assert env.executor.run_once() is True
    job = env.service.get_draft(draft_id).latest_job
    assert job is not None and (job.status, job.error_code) == ("failed", "source_unavailable")
    assert env.runner.chunks == []


def test_images_without_recognition_become_items_to_acknowledge(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    source = env.service.add_source(draft_id, "op1", "流程图.png", png_bytes())
    assert (source.chunk_count, source.image_count) == (0, 1)
    env.service.request_generation(draft_id, "op1", "k1")
    assert env.executor.run_once() is True
    detail = env.service.get_draft(draft_id)
    image = next(item for item in detail.findings if item.kind == "image_unrecognized")
    assert (image.origin, image.field_path, image.note, image.status) == ("system", "", "recognition_disabled", "open")
    assert image.locator.startswith("流程图.png")
    assert all(chunk.origin == "text" for chunk in env.runner.chunks)
    with pytest.raises(ValidationProblem):
        env.service.resolve_finding(draft_id, image.finding_id, "op1", "redact")
    resolved = env.service.resolve_finding(draft_id, image.finding_id, "op1", "acknowledge")
    assert next(item for item in resolved.findings if item.finding_id == image.finding_id).status == "acknowledged"


def test_vision_recognition_feeds_low_confidence_chunks_and_fails_when_most_images_fail(env):
    draft_id = env.draft(image_recognition="vision")
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.add_source(draft_id, "op1", "图一.png", png_bytes(color=(10, 10, 200)))
    env.service.add_source(draft_id, "op1", "图二.png", png_bytes(color=(10, 200, 10)))
    env.service.request_generation(draft_id, "op1", "k1")
    env.runner.unreadable = {"s3-i1"}
    assert env.executor.run_once() is True
    detail = env.service.get_draft(draft_id)
    image_chunks = [chunk for chunk in env.runner.chunks if chunk.origin == "image"]
    assert [(chunk.chunk_id, chunk.low_confidence) for chunk in image_chunks] == [("s2-i1-b1", True)]
    assert [item.note for item in detail.findings if item.kind == "image_unrecognized"] == ["unreadable"]
    assert detail.usage["total_tokens"] == 120

    env.runner.unreadable = {"s2-i1", "s3-i1"}
    env.service.request_generation(draft_id, "op1", "k2")
    assert env.executor.run_once() is True
    job = env.service.get_draft(draft_id).latest_job
    assert job is not None and (job.status, job.error_code, job.usage["total_tokens"]) == ("failed", "image_recognition_failed", 20)


def test_a_text_only_model_cannot_run_vision_recognition(env):
    draft_id = env.draft(image_recognition="vision")
    env.service.add_source(draft_id, "op1", "图一.png", png_bytes())
    env.service.request_generation(draft_id, "op1", "k1")
    env.models.input = ["text"]
    assert env.executor.run_once() is True
    job = env.service.get_draft(draft_id).latest_job
    assert job is not None and job.error_code == "vision_unsupported"


def test_a_job_interrupted_too_many_times_is_failed_instead_of_retried_forever(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    for attempt in range(MAX_ATTEMPTS):
        assert env.repo.claim_job(f"crashed-{attempt}", 60) is not None
        env.clock.now += timedelta(seconds=61)
    assert env.executor.run_once() is True
    job = env.service.get_draft(draft_id).latest_job
    assert job is not None and (job.status, job.error_code, job.attempt) == ("failed", "attempts_exhausted", MAX_ATTEMPTS + 1)
    assert env.runner.chunks == []


def test_a_job_taken_over_by_another_instance_writes_nothing(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")

    def take_over() -> None:
        env.clock.now += timedelta(seconds=600)
        assert env.repo.claim_job("w2", 600) is not None

    env.runner.before_return = take_over
    assert env.executor.run_once() is True
    detail = env.service.get_draft(draft_id)
    assert (detail.status, detail.package) == ("generating", None)
    assert detail.latest_job is not None and detail.latest_job.status == "parsing"


def test_shutdown_stops_claiming_and_closes_the_runner(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    env.executor.shutdown()
    assert env.executor.run_once() is False and env.runner.closed
    assert env.service.get_draft(draft_id).status == "generating"


# ---- 正文编辑与敏感项 ----

def test_editing_requires_the_current_version_and_rescans(env):
    draft_id = env.generated()
    detail = env.service.get_draft(draft_id)
    assert detail.package is not None
    chunk_id = next(iter(detail.evidence_sources))
    with pytest.raises(Conflict):
        env.service.update_package(draft_id, "op2", PackageUpdate(version=detail.version - 1, package=detail.package))

    edited = GeneratedSolution.model_validate(_solution(chunk_id, extra=f"邮箱 {EMAIL}。"))
    updated = env.service.update_package(draft_id, "op2", PackageUpdate(version=detail.version, package=edited))
    by_kind = {item.kind: item for item in updated.findings}
    assert (by_kind["phone"].status, by_kind["phone"].resolved_by) == ("removed", "op2")
    assert (by_kind["email"].status, by_kind["email"].field_path) == ("open", "experts[0].system_prompt")
    assert updated.version == detail.version + 1 and updated.updated_by == "op2"

    # 把已删掉的内容改回来：原发现项重新打开，而不是悄悄通过。
    restored = GeneratedSolution.model_validate(_solution(chunk_id))
    reopened = env.service.update_package(draft_id, "op2", PackageUpdate(version=updated.version, package=restored))
    phone = next(item for item in reopened.findings if item.kind == "phone")
    assert (phone.status, phone.resolved_by, phone.finding_id) == ("open", None, by_kind["phone"].finding_id)

    foreign = GeneratedSolution.model_validate(_solution("s9-c9"))
    with pytest.raises(ValidationProblem):
        env.service.update_package(draft_id, "op2", PackageUpdate(version=reopened.version, package=foreign))


def test_redact_remove_and_accept_public(env):
    draft_id = env.generated()
    phone_id = _open(env.service.get_draft(draft_id))["phone"]
    with pytest.raises(ValidationProblem):
        env.service.resolve_finding(draft_id, phone_id, "op1", "acknowledge")
    redacted = env.service.resolve_finding(draft_id, phone_id, "op1", "redact")
    assert redacted.package is not None
    assert redacted.package.experts[0].system_prompt == "你是质检协调专家。联系电话 [已脱敏]。"
    assert PHONE not in redacted.model_dump_json()
    with pytest.raises(Conflict):
        env.service.resolve_finding(draft_id, phone_id, "op1", "redact")
    with pytest.raises(NotFound):
        env.service.resolve_finding(draft_id, "00000000-0000-4000-8000-000000000000", "op1", "redact")

    chunk_id = next(iter(redacted.evidence_sources))
    with_email = GeneratedSolution.model_validate(_solution(chunk_id, extra=f"邮箱 {EMAIL}，预算 ¥1,200,000 元。"))
    edited = env.service.update_package(draft_id, "op1", PackageUpdate(version=redacted.version, package=with_email))
    removed = env.service.resolve_finding(draft_id, _open(edited)["email"], "op1", "remove")
    assert removed.package is not None and removed.package.experts[0].system_prompt == "你是质检协调专家。邮箱 ，预算 ¥1,200,000 元。"
    accepted = env.service.resolve_finding(draft_id, _open(removed)["amount"], "op1", "accept_public")
    assert accepted.package is not None and "¥1,200,000 元" in accepted.package.experts[0].system_prompt
    assert {item.kind: item.status for item in accepted.findings} == {
        "phone": "redacted", "company": "open", "email": "removed", "amount": "accepted_public",
    }
    actions = [event.action for event in accepted.events]
    assert actions[-3:] == ["package_edited", "finding_removed", "finding_accepted_public"]


def test_removing_content_that_would_empty_a_required_field_is_refused(env):
    draft_id = env.generated()
    detail = env.service.get_draft(draft_id)
    chunk_id = next(iter(detail.evidence_sources))
    body = _solution(chunk_id)
    body["experts"][1]["description"] = EMAIL
    edited = env.service.update_package(draft_id, "op1", PackageUpdate(version=detail.version, package=GeneratedSolution.model_validate(body)))
    with pytest.raises(ValidationProblem):
        env.service.resolve_finding(draft_id, _open(edited)["email"], "op1", "remove")
    assert env.service.get_draft(draft_id).version == edited.version


# ---- 审核与发布 ----

def test_review_flow_blocks_on_open_findings_and_publishes_to_the_catalog(env):
    draft_id = env.generated()
    with pytest.raises(Conflict):
        env.service.submit_review(draft_id, "op1")
    _resolve_all(env, draft_id)
    with pytest.raises(InvalidTransition):
        env.service.approve(draft_id, "admin", "")
    assert env.service.submit_review(draft_id, "op1").status == "in_review"
    detail = env.service.get_draft(draft_id)
    assert detail.package is not None
    with pytest.raises(InvalidTransition):
        env.service.update_package(draft_id, "op1", PackageUpdate(version=detail.version, package=detail.package))
    with pytest.raises(InvalidTransition):
        env.service.publish(draft_id, "admin")
    assert env.service.approve(draft_id, "admin", " 可以发布 ").review_note == "可以发布"

    published = env.service.publish(draft_id, "admin")
    solution_id = published.published_solution_id
    assert published.status == "published" and solution_id and solution_id.startswith("sa-")
    package = env.catalog.pull_solution_package(solution_id=solution_id)
    assert (package.display_name, package.output_requirements) == ("来料质检方案", "列出依据。")
    assert [expert.template_id for expert in package.experts] == [f"{solution_id}-lead", f"{solution_id}-inspector"]
    assert package.coordinator_template_id == f"{solution_id}-lead"
    assert package.experts[0].system_prompt == "你是质检协调专家。联系电话 [已脱敏]。"
    assert package.experts[0].platform_model_ref == MODEL_REF
    assert sorted(env.gateway.notifications) == sorted(
        [(f"{solution_id}-lead", "published"), (f"{solution_id}-inspector", "published"), (solution_id, "published")],
    )
    assert [event.action for event in published.events][-4:] == ["submitted_for_review", "approved", "publish_started", "published"]
    with pytest.raises(InvalidTransition):
        env.service.publish(draft_id, "admin")


def test_a_publish_that_fails_midway_can_be_retried_without_duplicates(env):
    draft_id = env.generated()
    _resolve_all(env, draft_id)
    env.service.submit_review(draft_id, "op1")
    env.service.approve(draft_id, "admin", "")

    real_publish = env.catalog.publish_template
    calls: list[str] = []

    def flaky(catalog_type, template_id, req):
        calls.append(template_id)
        if len(calls) == 2:
            raise Conflict("catalog is temporarily unavailable")
        return real_publish(catalog_type, template_id, req)

    env.catalog.publish_template = flaky  # type: ignore[method-assign]
    with pytest.raises(Conflict):
        env.service.publish(draft_id, "admin")
    assert env.service.get_draft(draft_id).status == "approved"

    # 部分专家已发布：不能再驳回（否则已发布的专家失去归属），只能重试发布。
    with pytest.raises(InvalidTransition):
        env.service.reject(draft_id, "admin", "想改一下")
    assert env.service.get_draft(draft_id).status == "approved"

    env.catalog.publish_template = real_publish  # type: ignore[method-assign]
    published = env.service.publish(draft_id, "admin")
    solution_id = published.published_solution_id
    assert published.status == "published" and solution_id
    entries = env.catalog.list_catalog()
    assert len(entries) == 3 and all(entry.status == CatalogStatus.PUBLISHED for entry in entries)
    assert env.catalog.get_entry(CatalogType.SOLUTION_TEMPLATE, solution_id).status == CatalogStatus.PUBLISHED
    assert len(env.gateway.notifications) == 3


def test_reject_needs_a_reason_and_reopens_the_draft_for_editing(env):
    draft_id = env.generated()
    _resolve_all(env, draft_id)
    env.service.submit_review(draft_id, "op1")
    with pytest.raises(ValidationProblem):
        env.service.reject(draft_id, "admin", "  ")
    rejected = env.service.reject(draft_id, "admin", "协作说明过于笼统")
    assert (rejected.status, rejected.review_note) == ("rejected", "协作说明过于笼统")
    assert all("笼统" not in event.summary for event in rejected.events)
    assert rejected.package is not None
    env.service.update_package(draft_id, "op1", PackageUpdate(version=rejected.version, package=rejected.package))
    resubmitted = env.service.submit_review(draft_id, "op1")
    assert (resubmitted.status, resubmitted.review_note) == ("in_review", "")


def test_archive_deletes_source_files_but_not_while_generating(env):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    with pytest.raises(InvalidTransition):
        env.service.archive_draft(draft_id, "op1")
    assert env.executor.run_once() is True
    env.service.archive_draft(draft_id, "op1")
    env.service.archive_draft(draft_id, "op1")
    assert env.files() == [] and env.service.list_drafts() == []
    assert env.service.get_draft(draft_id).status == "archived"


def test_only_a_reviewer_can_archive_an_approved_or_published_draft(env):
    draft_id = env.generated()
    _resolve_all(env, draft_id)
    env.service.submit_review(draft_id, "op1")
    env.service.approve(draft_id, "admin", "")
    with pytest.raises(Forbidden):
        env.service.archive_draft(draft_id, "op1")
    env.service.publish(draft_id, "admin")
    with pytest.raises(Forbidden):
        env.service.archive_draft(draft_id, "op1")
    assert env.service.get_draft(draft_id).status == "published" and env.files() != []
    env.service.archive_draft(draft_id, "admin", can_archive_reviewed=True)
    assert env.service.get_draft(draft_id).status == "archived" and env.files() == []


def test_a_failed_file_cleanup_keeps_the_rows_so_a_retry_finishes_it(env, monkeypatch):
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    real_delete = env.store.delete_draft

    def broken(_draft_id: str) -> None:
        raise SourceStorageError("disk unavailable")

    monkeypatch.setattr(env.store, "delete_draft", broken)
    with pytest.raises(SourceStorageError):
        env.service.archive_draft(draft_id, "op1")
    assert env.service.get_draft(draft_id).status == "archived"
    assert len(env.repo.list_sources(draft_id)) == 1 and len(env.files()) == 1  # 行与文件都还在，没有孤儿

    monkeypatch.setattr(env.store, "delete_draft", real_delete)
    env.service.archive_draft(draft_id, "op1")
    assert env.repo.list_sources(draft_id) == [] and env.files() == []


# ---- 真实 Node worker（假模型）全链路 ----

@real_worker
def test_end_to_end_with_the_real_worker_and_the_faux_model(env):
    executor = GenerationJobExecutor(env.repo, env.store, env.models, PiWorkerRunner(allow_faux=True), owner="w1", clock=env.clock)
    draft_id = env.draft(image_recognition="vision")
    document = docx_bytes(["来料检验流程：抽样、检验、判定。", f"异常联系 {PHONE} 处理。"], images=[png_bytes()])
    source = env.service.add_source(draft_id, "op1", "质量手册.docx", document)
    assert source.image_count == 1
    env.service.request_generation(draft_id, "op1", "k1")
    assert executor.run_once() is True

    detail = env.service.get_draft(draft_id)
    assert detail.latest_job is not None and detail.latest_job.error_code is None
    assert detail.status == "ready_for_review" and detail.package is not None
    assert len(detail.package.experts) == 2 and detail.evidence_sources
    assert detail.usage["tool_calls"] >= 3
    assert not [item for item in detail.findings if item.kind == "image_unrecognized"]

    _resolve_all(env, draft_id)
    env.service.submit_review(draft_id, "op1")
    env.service.approve(draft_id, "admin", "")
    published = env.service.publish(draft_id, "admin")
    assert published.published_solution_id
    package = env.catalog.pull_solution_package(solution_id=published.published_solution_id)
    assert len(package.experts) == 2 and PHONE not in package.model_dump_json()
