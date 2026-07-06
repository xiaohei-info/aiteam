"""Manager 审计事件路由 Pydantic schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AuditEventOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    event_type: str
    actor_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    detail: dict = {}
    created_at: datetime
