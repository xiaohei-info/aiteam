from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class EmployeeAvatarIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(default="avatar", min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=64)
    data: str = Field(min_length=1, max_length=7_000_000)


class EmployeeAvatarOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    avatar_url: str = Field(description="同源相对内容路径（带 ?v=版本）")
    version: int
    updated_at: datetime
