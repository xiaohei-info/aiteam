"""Settings 路由 Pydantic schema（B08）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EnterpriseSettingsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprise_name: str = ""
    logo_url: str | None = None
    phone: str | None = None
    contact_email: str = ""
    invite_required: bool = True
    member_approval: bool = True
    max_employees: int = 100
    features: dict[str, Any] = Field(default_factory=dict, description="企业功能开关 JSON。")
    updated_at: datetime


class EnterpriseSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprise_name: str | None = None
    logo_url: str | None = None
    phone: str | None = None
    contact_email: str | None = None
    invite_required: bool | None = None
    member_approval: bool | None = None
    max_employees: int | None = None
    features: dict[str, Any] | None = None


class AdminInviteOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invite_id: str
    phone: str
    display_name: str
    status: str = "pending"
    created_at: datetime


class AdminInviteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phone: str
    display_name: str = ""
