"""行业文档生成：运营端北向 API 边界 schema（/api/operation/solution-authoring）。

草稿内容的权威 schema 是 `shared.solution_authoring.schemas.GeneratedSolution`，这里不重定义。
敏感项对外只给脱敏后的 `masked`；原文片段只留在库里用于定位与替换。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from shared.contracts.platform_provider import PlatformModelRef
from shared.solution_authoring.prompts import MAX_SUPPLEMENT_CHARS
from shared.solution_authoring.schemas import GeneratedSolution

from .solution_authoring_repository import (
    DraftRow,
    EventRow,
    FindingRow,
    JobRow,
    SourceRow,
)

DraftStatus = Literal[
    "draft", "generating", "ready_for_review", "in_review", "approved", "published", "rejected", "archived",
]
ImageRecognition = Literal["none", "vision"]
FindingResolution = Literal["redact", "remove", "accept_public", "acknowledge"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- 请求 ----

class DraftCreate(_Strict):
    title: str = Field(min_length=1, max_length=80, description="草稿标题（仅运营端内部可见）")
    platform_model_ref: PlatformModelRef = Field(description="用于生成的已发布平台模型；也是生成出的专家的默认模型")
    image_recognition: ImageRecognition = Field(
        default="none", description="图片识别方式：none 不识别（图片记为待人工处理项）；vision 用所选多模态模型识别",
    )
    supplement: str = Field(default="", max_length=MAX_SUPPLEMENT_CHARS, description="对生成侧重点的补充说明；不能覆盖平台规则")

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class PackageUpdate(_Strict):
    version: int = Field(ge=1, description="编辑所基于的草稿版本；与当前版本不一致时返回 409")
    package: GeneratedSolution


class FindingResolve(_Strict):
    resolution: FindingResolution = Field(
        description=(
            "redact 用占位符替换正文中的该内容；remove 从正文中删除该内容；"
            "accept_public 确认该内容可公开；acknowledge 确认已知悉（仅用于不在正文中的提示项）"
        ),
    )


class ReviewNote(_Strict):
    note: str = Field(default="", max_length=1000)


# ---- 响应 ----

class SourceOut(_Strict):
    source_id: str
    file_name: str
    size_bytes: int
    status: Literal["uploaded", "parsed", "failed"]
    error_code: str | None = None
    chunk_count: int = Field(description="可引用的文本片段数")
    image_count: int = Field(description="待识别图片数")
    warnings: list[str] = Field(default_factory=list)
    created_at: datetime

    @classmethod
    def of(cls, row: SourceRow) -> SourceOut:
        return cls(
            source_id=row.source_id, file_name=row.file_name, size_bytes=row.size_bytes, status=row.status,  # type: ignore[arg-type]
            error_code=row.error_code, chunk_count=row.chunk_count, image_count=row.image_count,
            warnings=[str(item) for item in row.warnings], created_at=row.created_at,
        )


class JobOut(_Strict):
    job_id: str
    status: Literal["queued", "parsing", "analyzing", "succeeded", "failed"]
    attempt: int
    error_code: str | None = None
    error_message: str | None = Field(default=None, description="失败说明；不含文档内容与密钥")
    usage: dict[str, int] = Field(default_factory=dict)
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @classmethod
    def of(cls, row: JobRow) -> JobOut:
        return cls(
            job_id=row.job_id, status=row.status, attempt=row.attempt, error_code=row.error_code,  # type: ignore[arg-type]
            error_message=row.error_message, usage=_int_values(row.usage), created_at=row.created_at,
            started_at=row.started_at, finished_at=row.finished_at,
        )


class JobBriefOut(_Strict):
    """列表用的最近任务概要：只有状态与时间，不含错误详情与用量。"""

    status: Literal["queued", "parsing", "analyzing", "succeeded", "failed"]
    error_code: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None

    @classmethod
    def of(cls, row: JobRow) -> JobBriefOut:
        return cls(
            status=row.status, error_code=row.error_code, created_at=row.created_at,  # type: ignore[arg-type]
            started_at=row.started_at, finished_at=row.finished_at,
        )


class FindingOut(_Strict):
    finding_id: str
    kind: str = Field(description="phone / email / id_card / bank_card / secret / amount / company / person / other / image_unrecognized")
    origin: Literal["rule", "agent", "system"]
    field_path: str = Field(description="命中的正文字段；空串表示该项不在正文中（只能 acknowledge）")
    masked: str = Field(description="脱敏后的片段")
    locator: str = Field(description="来源位置（资料名 · 页 / 段）")
    note: str
    status: Literal["open", "redacted", "removed", "accepted_public", "acknowledged"]
    resolved_by: str | None = None
    resolved_at: datetime | None = None
    created_at: datetime

    @classmethod
    def of(cls, row: FindingRow) -> FindingOut:
        return cls(
            finding_id=row.finding_id, kind=row.kind, origin=row.origin, field_path=row.field_path,  # type: ignore[arg-type]
            masked=row.masked, locator=row.locator, note=row.note, status=row.status,  # type: ignore[arg-type]
            resolved_by=row.resolved_by, resolved_at=row.resolved_at, created_at=row.created_at,
        )


class EventOut(_Strict):
    action: str
    actor_id: str
    summary: str
    created_at: datetime

    @classmethod
    def of(cls, row: EventRow) -> EventOut:
        return cls(action=row.action, actor_id=row.actor_id, summary=row.summary, created_at=row.created_at)


class EvidenceSourceOut(_Strict):
    source_name: str
    locator: str
    excerpt: str
    origin: Literal["text", "image"] = "text"
    low_confidence: bool = Field(default=False, description="来自图片识别且置信度低，需人工核对")


class SourceWarningOut(_Strict):
    file_name: str
    code: str


class DraftOut(_Strict):
    draft_id: str
    title: str
    status: DraftStatus
    platform_model_ref: PlatformModelRef
    image_recognition: ImageRecognition
    version: int
    published_solution_id: str | None = None
    created_by: str
    updated_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, row: DraftRow) -> DraftOut:
        return cls(**_draft_fields(row))


class DraftSummaryOut(DraftOut):
    latest_job: JobBriefOut | None = None

    @classmethod
    def summarize(cls, row: DraftRow, job: JobRow | None) -> DraftSummaryOut:
        return cls(**_draft_fields(row), latest_job=JobBriefOut.of(job) if job is not None else None)


class DraftDetailOut(DraftOut):
    supplement: str
    package: GeneratedSolution | None = Field(default=None, description="生成的方案内容；尚未生成成功时为 null")
    evidence_sources: dict[str, EvidenceSourceOut] = Field(default_factory=dict, description="被引用的来源片段：chunk_id → 位置与摘录")
    warnings: list[SourceWarningOut] = Field(default_factory=list)
    prompt_version: str
    usage: dict[str, int] = Field(default_factory=dict)
    review_note: str
    publish_started: bool = Field(default=False, description="发布是否已开始（含中途失败）。为 true 时不能再驳回，只能重试发布")
    sources: list[SourceOut] = Field(default_factory=list)
    findings: list[FindingOut] = Field(default_factory=list)
    open_finding_count: int
    events: list[EventOut] = Field(default_factory=list)
    latest_job: JobOut | None = None

    @classmethod
    def assemble(
        cls, row: DraftRow, *, sources: list[SourceRow], findings: list[FindingRow], events: list[EventRow], job: JobRow | None,
    ) -> DraftDetailOut:
        return cls(
            **_draft_fields(row),
            supplement=row.supplement,
            package=GeneratedSolution.model_validate(row.package) if row.package is not None else None,
            evidence_sources={key: EvidenceSourceOut.model_validate(value) for key, value in row.evidence_sources.items()},
            warnings=[SourceWarningOut.model_validate(item) for item in row.warnings],
            prompt_version=row.prompt_version,
            usage=_int_values(row.usage),
            review_note=row.review_note,
            publish_started=bool(row.publish_state),
            sources=[SourceOut.of(item) for item in sources],
            findings=[FindingOut.of(item) for item in findings],
            open_finding_count=sum(1 for item in findings if item.status == "open"),
            events=[EventOut.of(item) for item in events],
            latest_job=JobOut.of(job) if job is not None else None,
        )


def _draft_fields(row: DraftRow) -> dict[str, Any]:
    return {
        "draft_id": row.draft_id, "title": row.title, "status": row.status,
        "platform_model_ref": PlatformModelRef(provider_id=row.model_provider_id, model_id=row.model_id),
        "image_recognition": row.image_recognition, "version": row.version,
        "published_solution_id": row.published_solution_id, "created_by": row.created_by, "updated_by": row.updated_by,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }


def _int_values(values: dict[str, Any]) -> dict[str, int]:
    return {key: value for key, value in values.items() if isinstance(value, int) and not isinstance(value, bool)}
