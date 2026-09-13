from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class EmployeeAvatarIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=64)
    data: str = Field(min_length=1, max_length=7_000_000)


class EmployeeAvatarOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    avatar_url: str
    version: int
    updated_at: datetime
