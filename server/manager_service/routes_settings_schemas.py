"""Settings 路由 Pydantic schema（B08）。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class EnterpriseSettingsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprise_name: str = ""
    logo_url: str | None = None
    phone: str | None = None
    updated_at: datetime


class EnterpriseSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enterprise_name: str | None = None
    logo_url: str | None = None


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
