"""Manager 审计事件路由 Pydantic schema。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AuditEventOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    event_type: str
    actor_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict, description="脱敏审计详情。")
    created_at: datetime
