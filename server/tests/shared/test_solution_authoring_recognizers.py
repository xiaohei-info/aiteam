"""图片识别统一接口：不识别、多模态分批与失败隔离、识别结果转来源片段。"""

from __future__ import annotations

import pytest

from shared.solution_authoring.recognizers import (
    NoopImageRecognizer,
    VisionImageRecognizer,
    VisionLimits,
    chunks_from_recognition,
)
from shared.solution_authoring.runner import (
    AuthoringBudget,
    FauxModelConfig,
    RecognizeOutcome,
    WorkerError,
)
from shared.solution_authoring.schemas import (
    AuthoringUsage,
    ImageAsset,
    RecognizedBlock,
    RecognizedImage,
)

VISION = FauxModelConfig(input=["text", "image"])


def _images(count: int) -> list[ImageAsset]:
    return [
        ImageAsset(image_id=f"s1-i{n}", source_id="s1", source_name="扫描.pdf", locator=f"第 {n} 页图片", media_type="image/jpeg", data=b"x")
        for n in range(1, count + 1)
    ]


class _Runner:
    """记录每批请求；`failures` 指定第几批（从 0 起）抛什么错误码。"""

    def __init__(self, failures: dict[int, str] | None = None):
        self.batches: list[list[str]] = []
        self.budgets: list[AuthoringBudget] = []
        self.aborts: list = []
        self._failures = failures or {}

    def recognize(self, images, *, model, budget, system_prompt, task_prompt, abort=None):
        self.aborts.append(abort)
        index = len(self.batches)
        self.batches.append([image.image_id for image in images])
        self.budgets.append(budget)
        assert model is VISION and system_prompt and task_prompt
        if index in self._failures:
            raise WorkerError(self._failures[index], "boom", AuthoringUsage(total_tokens=7, turns=1))
        return RecognizeOutcome(
            images=[
                RecognizedImage(image_id=image.image_id, status="recognized", blocks=[RecognizedBlock(text="内容", confidence=0.9)])
                for image in images
            ],
            usage=AuthoringUsage(input_tokens=80, output_tokens=20, total_tokens=100, turns=len(images), tool_calls=len(images)),
        )


def test_noop_marks_every_image_unrecognized():
    outcome = NoopImageRecognizer().recognize(_images(2))
    assert [(item.image_id, item.status, item.reason) for item in outcome.images] == [
        ("s1-i1", "unrecognized", "recognition_disabled"),
        ("s1-i2", "unrecognized", "recognition_disabled"),
    ]
    assert outcome.usage.total_tokens == 0


def test_vision_requires_a_model_with_image_input():
    with pytest.raises(WorkerError) as raised:
        VisionImageRecognizer(_Runner(), FauxModelConfig())
    assert raised.value.code == "vision_unsupported"


def test_vision_batches_images_and_scales_the_budget_per_batch():
    runner = _Runner()
    limits = VisionLimits(batch_size=2, tokens_per_image=1000, timeout_ms_per_image=5000)
    outcome = VisionImageRecognizer(runner, VISION, limits).recognize(_images(5))
    assert runner.batches == [["s1-i1", "s1-i2"], ["s1-i3", "s1-i4"], ["s1-i5"]]
    assert [(b.max_total_tokens, b.timeout_ms, b.max_turns) for b in runner.budgets] == [(2000, 10000, 10), (2000, 10000, 10), (1000, 5000, 5)]
    assert {b.model_retries for b in runner.budgets} == {2}
    assert [item.status for item in outcome.images] == ["recognized"] * 5
    assert (outcome.usage.total_tokens, outcome.usage.turns) == (300, 5)


def test_a_failed_batch_only_marks_its_own_images_and_keeps_usage():
    runner = _Runner(failures={1: "worker_timeout"})
    outcome = VisionImageRecognizer(runner, VISION, VisionLimits(batch_size=2)).recognize(_images(5))
    assert [(item.image_id, item.status, item.reason) for item in outcome.images] == [
        ("s1-i1", "recognized", ""), ("s1-i2", "recognized", ""),
        ("s1-i3", "unrecognized", "worker_timeout"), ("s1-i4", "unrecognized", "worker_timeout"),
        ("s1-i5", "recognized", ""),
    ]
    assert outcome.usage.total_tokens == 100 + 7 + 100


@pytest.mark.parametrize("code", ["vision_unsupported", "worker_unavailable", "faux_not_allowed", "invalid_job"])
def test_failures_unrelated_to_a_particular_image_abort_the_whole_recognition(code):
    runner = _Runner(failures={0: code})
    with pytest.raises(WorkerError) as raised:
        VisionImageRecognizer(runner, VISION, VisionLimits(batch_size=2)).recognize(_images(5))
    assert raised.value.code == code and len(runner.batches) == 1


def test_no_images_means_no_worker_calls():
    runner = _Runner()
    assert VisionImageRecognizer(runner, VISION).recognize([]).images == [] and runner.batches == []


def test_chunks_from_recognition_flags_low_confidence_and_lists_unrecognized():
    images = _images(4)
    recognized = [
        RecognizedImage(image_id="s1-i1", status="recognized", blocks=[
            RecognizedBlock(text="来料检验流程", kind="text", confidence=0.95),
            RecognizedBlock(text="日期 | 结果", kind="table", confidence=0.59),
            RecognizedBlock(text="收货 → 检验 → 入库", kind="chart", confidence=0.6),
        ]),
        RecognizedImage(image_id="s1-i2", status="unrecognized", reason="空白页"),
        RecognizedImage(image_id="s1-i3", status="recognized", blocks=[]),
        # s1-i4 没有任何结果
    ]
    chunks, missing = chunks_from_recognition(images, recognized)
    assert [(c.chunk_id, c.text, c.origin, c.low_confidence, c.locator) for c in chunks] == [
        ("s1-i1-b1", "来料检验流程", "image", False, "第 1 页图片"),
        ("s1-i1-b2", "[表格] 日期 | 结果", "image", True, "第 1 页图片"),
        ("s1-i1-b3", "[图表] 收货 → 检验 → 入库", "image", False, "第 1 页图片"),
    ]
    assert [(m.image_id, m.reason, m.locator) for m in missing] == [
        ("s1-i2", "空白页", "第 2 页图片"), ("s1-i3", "no_result", "第 3 页图片"), ("s1-i4", "no_result", "第 4 页图片"),
    ]
    assert chunks_from_recognition(images[:1], recognized, low_confidence_threshold=0.99)[0][0].low_confidence is True


def test_vision_recognizer_hands_the_abort_event_to_every_batch():
    import threading

    abort = threading.Event()
    runner = _Runner()
    VisionImageRecognizer(runner, VISION, abort=abort).recognize(_images(20))
    assert len(runner.aborts) == 3 and all(item is abort for item in runner.aborts)
