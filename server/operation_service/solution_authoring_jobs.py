"""行业文档生成：任务执行器（Operator 进程内，后台线程里跑）。

一次任务：领取 → 解析资料 → 识别图片 → 起 Pi worker 子进程生成 → 宿主校验 → 与草稿内容一起提交。
失败不落任何半成品；执行期间持续续租，租约丢失（被别的实例接管）或宿主关停时什么都不写。
日志与任务错误信息只含错误码、计数与异常类型，不含文档正文、模型输出与密钥。
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import threading
import uuid
from collections.abc import Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, Protocol

from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import AppError
from shared.solution_authoring.isolated_parse import parse_source_isolated
from shared.solution_authoring.parsing import ParseLimits, SourceParseError
from shared.solution_authoring.prompts import (
    PROMPT_VERSION,
    generate_system_prompt,
    generate_task_prompt,
)
from shared.solution_authoring.recognizers import (
    ImageRecognizer,
    NoopImageRecognizer,
    UnrecognizedImage,
    VisionImageRecognizer,
    chunks_from_recognition,
)
from shared.solution_authoring.runner import (
    AuthoringBudget,
    GenerateOutcome,
    ModelConfig,
    RecognizeOutcome,
    WorkerError,
)
from shared.solution_authoring.schemas import AuthoringUsage, ImageAsset, SourceChunk

from .solution_authoring_findings import IMAGE_UNRECOGNIZED, initial_findings
from .solution_authoring_models import ModelConfigResolver
from .solution_authoring_repository import (
    DraftChange,
    FindingRow,
    JobRow,
    SolutionAuthoringRepository,
)
from .solution_authoring_storage import SourceFileStore, SourceStorageError

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
MAX_IMAGES_PER_JOB = 60
MAX_EVIDENCE_EXCERPT_CHARS = 300
_USAGE_FIELDS = tuple(AuthoringUsage.model_fields)


class AuthoringRunner(Protocol):
    """`PiWorkerRunner` 满足；测试里用假实现。"""

    def generate(
        self, chunks: Sequence[SourceChunk], *, model: ModelConfig, budget: AuthoringBudget, system_prompt: str, task_prompt: str,
        abort: threading.Event | None = None,
    ) -> GenerateOutcome: ...

    def recognize(
        self, images: Sequence[ImageAsset], *, model: ModelConfig, budget: AuthoringBudget, system_prompt: str, task_prompt: str,
        abort: threading.Event | None = None,
    ) -> RecognizeOutcome: ...


class _JobFailure(Exception):
    def __init__(self, code: str, message: str, usage: AuthoringUsage | None = None):
        super().__init__(message)
        self.code = code
        self.usage = usage or AuthoringUsage()


def _sum(left: AuthoringUsage, right: AuthoringUsage) -> AuthoringUsage:
    return AuthoringUsage(**{name: getattr(left, name) + getattr(right, name) for name in _USAGE_FIELDS})


class _Lease:
    """执行期间的续租心跳。`lost` 置位后执行器不再写任何结果。"""

    def __init__(self, repo: SolutionAuthoringRepository, job_id: str, owner: str, lease_seconds: float):
        self._repo, self._job_id, self._owner, self._lease_seconds = repo, job_id, owner, lease_seconds
        self._status: str | None = None
        self._stop = threading.Event()
        self.lost = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="solution-authoring-lease", daemon=True)

    def __enter__(self) -> _Lease:
        self._thread.start()
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        self._stop.set()
        self._thread.join(timeout=10)

    def advance(self, status: str) -> None:
        self._status = status
        self._beat()

    def _loop(self) -> None:
        while not self._stop.wait(self._lease_seconds / 4):
            self._beat()

    def _beat(self) -> None:
        try:
            if not self._repo.heartbeat_job(self._job_id, self._owner, self._lease_seconds, status=self._status):
                self.lost.set()
        except Exception as exc:  # noqa: BLE001 — 数据库抖动：下一拍再试，租约到期前不算丢失
            logger.warning("solution generation lease heartbeat failed: job_id=%s error_type=%s", self._job_id, type(exc).__name__)


class GenerationJobExecutor:
    def __init__(
        self,
        repo: SolutionAuthoringRepository,
        store: SourceFileStore,
        models: ModelConfigResolver,
        runner: AuthoringRunner,
        *,
        owner: str | None = None,
        lease_seconds: float = 120.0,
        budget: AuthoringBudget | None = None,
        parse_limits: ParseLimits | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self._repo, self._store, self._models, self._runner = repo, store, models, runner
        self._owner = owner or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._lease_seconds = lease_seconds
        self._budget = budget or AuthoringBudget()
        self._parse_limits = parse_limits or ParseLimits()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._shutting_down = threading.Event()

    def shutdown(self) -> None:
        """宿主关停：在跑的任务不再写结果，租约到期后由下一个实例重做。"""
        self._shutting_down.set()
        close = getattr(self._runner, "close", None)
        if callable(close):
            close()

    def run_once(self) -> bool:
        """领取并执行一个任务。没有可领取的任务时返回 False。"""
        if self._shutting_down.is_set():
            return False
        job = self._repo.claim_job(self._owner, self._lease_seconds)
        if job is None:
            return False
        with _Lease(self._repo, job.job_id, self._owner, self._lease_seconds) as lease:
            try:
                if job.attempt > MAX_ATTEMPTS:
                    raise _JobFailure("attempts_exhausted", f"the job was interrupted {MAX_ATTEMPTS} times and will not be retried")
                change, usage = self._generate(job, lease)
            except _JobFailure as failure:
                self._finish(job, lease, error=(failure.code, str(failure)), usage=failure.usage)
            except Exception as exc:  # noqa: BLE001 — 异常消息可能带文档内容，只记类型
                logger.error("solution generation job crashed: job_id=%s error_type=%s", job.job_id, type(exc).__name__)
                self._finish(job, lease, error=("internal_error", "unexpected error while generating"), usage=AuthoringUsage())
            else:
                self._finish(job, lease, change=change, usage=usage)
        return True

    # ---- 内部 ----

    def _finish(
        self, job: JobRow, lease: _Lease, *, usage: AuthoringUsage,
        change: DraftChange | None = None, error: tuple[str, str] | None = None,
    ) -> None:
        if lease.lost.is_set() or self._shutting_down.is_set():
            logger.info("solution generation job abandoned without writing: job_id=%s", job.job_id)
            return
        totals = usage.model_dump(mode="json")
        if change is not None:
            written = self._repo.complete_job(job.draft_id, job.job_id, self._owner, change=change, usage=totals)
            outcome = "succeeded"
        else:
            code, message = error or ("internal_error", "")
            written = self._repo.fail_job(job.draft_id, job.job_id, self._owner, error_code=code, error_message=message, usage=totals)
            outcome = f"failed:{code}"
        logger.info(
            "solution generation job finished: job_id=%s outcome=%s written=%s attempt=%s total_tokens=%s",
            job.job_id, outcome, written, job.attempt, usage.total_tokens,
        )

    def _generate(self, job: JobRow, lease: _Lease) -> tuple[DraftChange, AuthoringUsage]:
        draft = self._repo.get_draft(job.draft_id)
        try:
            model = self._models.resolve(PlatformModelRef(provider_id=draft.model_provider_id, model_id=draft.model_id))
        except AppError as exc:
            reason = exc.detail if exc.detail else exc.title
            raise _JobFailure("model_unavailable", reason) from exc

        chunks: list[SourceChunk] = []
        images: list[ImageAsset] = []
        warnings: list[dict[str, str]] = []
        for source in self._repo.list_sources(job.draft_id):
            try:
                data = self._store.read(source.storage_key, source.sha256)
                parsed = parse_source_isolated(f"s{source.seq}", source.file_name, data, self._parse_limits)
            except SourceStorageError as exc:
                raise _JobFailure("source_unavailable", f"source document #{source.seq} is missing or corrupted in storage") from exc
            except SourceParseError as exc:
                raise _JobFailure("source_parse_failed", f"source document #{source.seq} could not be parsed ({exc.code})") from exc
            chunks.extend(parsed.chunks)
            images.extend(parsed.images)
            warnings.extend({"file_name": source.file_name, "code": code} for code in parsed.warnings)

        usage = AuthoringUsage()
        attempted, skipped = images[:MAX_IMAGES_PER_JOB], images[MAX_IMAGES_PER_JOB:]
        unrecognized = [
            UnrecognizedImage(image.image_id, image.source_id, image.source_name, image.locator, "image_limit") for image in skipped
        ]
        if attempted:
            vision = draft.image_recognition == "vision"
            try:
                recognizer: ImageRecognizer = VisionImageRecognizer(self._runner, model, abort=lease.lost) if vision else NoopImageRecognizer()
                recognition = recognizer.recognize(attempted)
            except WorkerError as error:
                raise _JobFailure(error.code, str(error), error.usage) from error
            usage = recognition.usage
            image_chunks, failed = chunks_from_recognition(attempted, recognition.images)
            if vision and len(failed) * 2 > len(attempted):
                raise _JobFailure(
                    "image_recognition_failed", f"{len(failed)} of {len(attempted)} images could not be recognized", usage,
                )
            chunks.extend(image_chunks)
            unrecognized = failed + unrecognized
        if not chunks:
            raise _JobFailure("no_content", "no readable text could be extracted from the source documents", usage)
        if lease.lost.is_set() or self._shutting_down.is_set():
            raise _JobFailure("abandoned", "the job was taken over or the host is shutting down", usage)

        lease.advance("analyzing")
        try:
            outcome = self._runner.generate(
                chunks, model=model, budget=self._budget,
                system_prompt=generate_system_prompt(), task_prompt=generate_task_prompt(draft.supplement), abort=lease.lost,
            )
        except WorkerError as error:
            raise _JobFailure(error.code, str(error), _sum(usage, error.usage)) from error
        usage = _sum(usage, outcome.usage)

        solution = outcome.result.solution
        package = solution.model_dump(mode="json")
        by_id = {chunk.chunk_id: chunk for chunk in chunks}
        now = self._clock()
        findings = initial_findings(package, outcome.result.findings, by_id, draft_id=job.draft_id, now=now)
        findings.extend(
            FindingRow(
                finding_id=str(uuid.uuid4()), draft_id=job.draft_id, kind=IMAGE_UNRECOGNIZED, origin="system", created_at=now,
                locator=f"{image.source_name} · {image.locator}"[:400], note=image.reason[:200],
            )
            for image in unrecognized
        )
        evidence: dict[str, Any] = {
            chunk_id: {
                "source_name": by_id[chunk_id].source_name, "locator": by_id[chunk_id].locator,
                "excerpt": by_id[chunk_id].text[:MAX_EVIDENCE_EXCERPT_CHARS], "origin": by_id[chunk_id].origin,
                "low_confidence": by_id[chunk_id].low_confidence,
            }
            for chunk_id in sorted(solution.evidence_chunk_ids()) if chunk_id in by_id
        }
        change = DraftChange(
            changes={
                "package": package, "status": "ready_for_review", "evidence_sources": evidence, "warnings": warnings,
                "prompt_version": PROMPT_VERSION, "usage": usage.model_dump(mode="json"), "review_note": "", "publish_state": {},
            },
            new_findings=findings, replace_findings=True,
            event=("generation_succeeded", f"{len(solution.experts)} experts, {len(findings)} findings"),
        )
        return change, usage


def install_solution_authoring_worker_lifespan(
    app, build_executor: Callable[[], GenerationJobExecutor], *, concurrency: int = 1, poll_seconds: float = 2.0,
) -> None:
    """在服务生命周期内跑任务轮询（Operation 没有独立的后台进程）。并发 = 同时生成的草稿数。"""
    original = app.router.lifespan_context
    concurrency = max(1, min(concurrency, 4))

    @asynccontextmanager
    async def lifespan(instance):
        async with original(instance):
            stop = asyncio.Event()
            executor: GenerationJobExecutor | None = None

            async def poll() -> None:
                nonlocal executor
                while not stop.is_set():
                    worked = False
                    try:
                        if executor is None:
                            executor = build_executor()
                        worked = await asyncio.to_thread(executor.run_once)
                    except Exception as exc:  # noqa: BLE001 — 存储或数据库暂不可用：下一轮再试
                        logger.warning("solution generation poll failed: error_type=%s", type(exc).__name__)
                    if worked:
                        continue
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
                    except TimeoutError:
                        continue

            tasks = [asyncio.create_task(poll()) for _ in range(concurrency)]
            try:
                yield
            finally:
                stop.set()
                if executor is not None:
                    executor.shutdown()
                await asyncio.gather(*tasks, return_exceptions=True)

    app.router.lifespan_context = lifespan
