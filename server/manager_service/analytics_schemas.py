"""Manager-safe read models for knowledge and memory analytics.

These models intentionally live apart from the mutable business schema module:
analytics are read projections over Manager-owned stores and external services,
not new domain persistence objects.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import KnowledgeDocumentSource, KnowledgeDocumentStatus


KnowledgeAnalyticsStatus = Literal["available", "unavailable", "not_configured"]


class KnowledgeActivityDay(BaseModel):
    """按 UTC 日期聚合的文档/intake 活动，不包含正文或上游原始事件。"""

    model_config = ConfigDict(extra="forbid")

    date: str
    activity_count: int = Field(ge=0)
    documents_created: int = Field(default=0, ge=0)
    documents_updated: int = Field(default=0, ge=0)
    ingestions: int = Field(default=0, ge=0)
    ready: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)


class KnowledgeDocumentAnalyticsOut(BaseModel):
    """单文档的 Manager intake、LightRAG 和检索绑定状态。"""

    model_config = ConfigDict(extra="forbid")

    document_id: str
    display_name: str
    source_type: KnowledgeDocumentSource
    file_name: str
    file_type: str
    file_size: int = Field(ge=0)
    text_chars: int | None = Field(default=None, ge=0)
    chunk_count: int | None = Field(default=None, ge=0)
    status: KnowledgeDocumentStatus
    ingestion_status: str | None = None
    upstream_status: str | None = None
    error_code: str | None = None
    binding_count: int = Field(default=0, ge=0)
    ready_binding_count: int = Field(default=0, ge=0)
    stale_binding_count: int = Field(default=0, ge=0)
    revoked_binding_count: int = Field(default=0, ge=0)
    pending_binding_count: int = Field(default=0, ge=0)
    ingestion_started_at: datetime | None = None
    ingestion_completed_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class KnowledgeAnalyticsOut(BaseModel):
    """企业固定 LightRAG workspace 的安全管理面统计。"""

    model_config = ConfigDict(extra="forbid")

    knowledge_space_id: str
    status: KnowledgeAnalyticsStatus
    document_count: int = Field(ge=0)
    ready_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    processing_count: int = Field(ge=0)
    deleted_count: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    total_text_chars: int = Field(ge=0)
    total_chunks: int = Field(ge=0)
    upstream_document_count: int | None = Field(default=None, ge=0)
    upstream_ready_count: int | None = Field(default=None, ge=0)
    upstream_failed_count: int | None = Field(default=None, ge=0)
    upstream_processing_count: int | None = Field(default=None, ge=0)
    last_activity_at: datetime | None = None
    refreshed_at: datetime
    daily_activity: list[KnowledgeActivityDay] = Field(default_factory=list)
    documents: list[KnowledgeDocumentAnalyticsOut] = Field(default_factory=list)


class MemoryEmployeeAnalyticsOut(BaseModel):
    """Per-employee Hindsight statistics; memory text stays on the detail route."""

    model_config = ConfigDict(extra="forbid")

    employee_id: str
    display_name: str
    memory_count: int = Field(ge=0)
    state_counts: dict[str, int] = Field(default_factory=dict)
    category_counts: dict[str, int] = Field(default_factory=dict)
    latest_created_at: str | None = None
    oldest_created_at: str | None = None
    latest_used_at: str | None = None
    average_importance: float | None = None
    max_importance: float | None = None
    truncated: bool = False


class MemoryAnalyticsOut(BaseModel):
    """Manager-safe Hindsight availability and per-employee summary."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["available", "partial", "unavailable", "not_configured"]
    employee_count: int = Field(ge=0)
    total_memory_count: int = Field(ge=0)
    refreshed_at: datetime
    employees: list[MemoryEmployeeAnalyticsOut] = Field(default_factory=list)
    unavailable_employee_count: int = Field(default=0, ge=0)
