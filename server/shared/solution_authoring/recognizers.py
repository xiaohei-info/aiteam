"""图片识别：统一接口 + 实现（设计 §3.8）。

`ImageRecognizer` 输入待识别图片，输出同构的 `RecognizedImage`；下游（分块、证据、敏感扫描、Agent）
不感知用了哪种实现。首期只有方案 B（多模态模型，D-V）与「不识别」；OCR（方案 A）实现同一接口后接入。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol

from .prompts import recognize_system_prompt, recognize_task_prompt
from .runner import AuthoringBudget, ModelConfig, RecognizeOutcome, WorkerError
from .schemas import AuthoringUsage, ImageAsset, RecognizedImage, SourceChunk

# 这些失败与具体图片无关，重试别的图片也没有意义：直接让整个任务失败。
_FATAL_CODES = frozenset({"vision_unsupported", "invalid_job", "faux_not_allowed", "worker_unavailable"})
_RECOGNIZE_RETRIES = 2
_KIND_PREFIX = {"text": "", "table": "[表格] ", "chart": "[图表] "}


@dataclass
class RecognitionOutcome:
    images: list[RecognizedImage] = field(default_factory=list)
    usage: AuthoringUsage = field(default_factory=AuthoringUsage)


class ImageRecognizer(Protocol):
    def recognize(self, images: Sequence[ImageAsset]) -> RecognitionOutcome: ...


class RecognizeRunner(Protocol):
    """多模态识别只依赖 worker 调用器的这一个方法（`PiWorkerRunner` 满足它）。"""

    def recognize(
        self,
        images: Sequence[ImageAsset],
        *,
        model: ModelConfig,
        budget: AuthoringBudget,
        system_prompt: str,
        task_prompt: str,
    ) -> RecognizeOutcome: ...


class NoopImageRecognizer:
    """不识别：每张图片都标记为未识别，由宿主记成发现项交人工处理。"""

    def recognize(self, images: Sequence[ImageAsset]) -> RecognitionOutcome:
        return RecognitionOutcome(images=[
            RecognizedImage(image_id=image.image_id, status="unrecognized", reason="recognition_disabled") for image in images
        ])


@dataclass(frozen=True)
class VisionLimits:
    batch_size: int = 8
    tokens_per_image: int = 30_000
    timeout_ms_per_image: int = 90_000


def _add(total: AuthoringUsage, part: AuthoringUsage) -> AuthoringUsage:
    return AuthoringUsage(**{name: getattr(total, name) + getattr(part, name) for name in AuthoringUsage.model_fields})


class VisionImageRecognizer:
    """方案 B：用宿主注入的多模态模型识别。按批起 worker 子进程，一批失败不影响其它批。"""

    def __init__(self, runner: RecognizeRunner, model: ModelConfig, limits: VisionLimits | None = None):
        if not model.supports_images:
            raise WorkerError("vision_unsupported", "the selected model does not accept image input")
        self._runner = runner
        self._model = model
        self._limits = limits or VisionLimits()

    def recognize(self, images: Sequence[ImageAsset]) -> RecognitionOutcome:
        outcome = RecognitionOutcome()
        size = self._limits.batch_size
        for start in range(0, len(images), size):
            batch = images[start:start + size]
            budget = AuthoringBudget(
                # 每张图正常 1–2 轮，再给临时错误的重试留出轮数。
                max_turns=len(batch) * (3 + _RECOGNIZE_RETRIES),
                model_retries=_RECOGNIZE_RETRIES,
                max_tool_calls=len(batch) * 3,
                max_total_tokens=len(batch) * self._limits.tokens_per_image,
                timeout_ms=min(len(batch) * self._limits.timeout_ms_per_image, 3_600_000),
                max_submit_attempts=1,
            )
            try:
                result = self._runner.recognize(
                    batch, model=self._model, budget=budget,
                    system_prompt=recognize_system_prompt(), task_prompt=recognize_task_prompt(),
                )
            except WorkerError as error:
                if error.code in _FATAL_CODES:
                    raise
                outcome.usage = _add(outcome.usage, error.usage)
                outcome.images.extend(
                    RecognizedImage(image_id=image.image_id, status="unrecognized", reason=error.code) for image in batch
                )
                continue
            outcome.usage = _add(outcome.usage, result.usage)
            outcome.images.extend(result.images)
        return outcome


@dataclass(frozen=True)
class UnrecognizedImage:
    image_id: str
    source_id: str
    source_name: str
    locator: str
    reason: str


def chunks_from_recognition(
    images: Sequence[ImageAsset],
    recognized: Sequence[RecognizedImage],
    *,
    low_confidence_threshold: float = 0.6,
) -> tuple[list[SourceChunk], list[UnrecognizedImage]]:
    """识别结果 → 来源片段（origin=image）+ 未识别清单。低于阈值的块带 low_confidence 标记，不静默采用。"""
    by_id = {item.image_id: item for item in recognized}
    chunks: list[SourceChunk] = []
    missing: list[UnrecognizedImage] = []
    for image in images:
        result = by_id.get(image.image_id)
        blocks = result.blocks if result and result.status == "recognized" else []
        if not blocks:
            missing.append(UnrecognizedImage(
                image_id=image.image_id, source_id=image.source_id, source_name=image.source_name,
                locator=image.locator, reason=(result.reason if result else "") or "no_result",
            ))
            continue
        for number, block in enumerate(blocks, start=1):
            chunks.append(SourceChunk(
                chunk_id=f"{image.image_id}-b{number}", source_id=image.source_id, source_name=image.source_name[:255],
                locator=image.locator[:120], text=f"{_KIND_PREFIX[block.kind]}{block.text}", origin="image",
                low_confidence=block.confidence < low_confidence_threshold,
            ))
    return chunks, missing
