"""Memory 路由 Pydantic schema（B07）。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MemoryItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    memory_id: str
    employee_id: str
    content: str
    category: str = "preference"
    importance: int = 3
    source: str = "manual"
    created_at: datetime
    last_used_at: datetime | None = None


class MemoryItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    content: str
    category: str = "preference"
    importance: int = Field(ge=1, le=5, default=3)


class MemoryItemPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str | None = None
    category: str | None = None
    importance: int | None = Field(default=None, ge=1, le=5)


class MemoryBulkDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    memory_ids: list[str]
