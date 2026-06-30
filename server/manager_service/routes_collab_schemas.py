"""Collab/Audit 路由 Pydantic schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CollaborationTemplateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_id: str = "default"
    name: str = "默认协作模板"
    routing_prompt: str = ""
    handoff_prompt: str = ""
    max_replies_per_message: int = 3
    updated_at: datetime


class CollaborationTemplateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    routing_prompt: str | None = None
    handoff_prompt: str | None = None
    max_replies_per_message: int | None = None


class AuditEventOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str
    event_type: str
    actor_id: str | None = None
    target_type: str | None = None
    target_id: str | None = None
    detail: dict = {}
    created_at: datetime
