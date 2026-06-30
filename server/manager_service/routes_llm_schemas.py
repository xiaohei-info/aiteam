"""LLM 路由 Pydantic schema（B01）。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LlmProviderOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_id: str
    name: str
    provider_key: str
    base_url: str | None = None
    is_active: bool = True
    model_count: int = 0
    created_at: datetime


class LlmProviderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    provider_key: str
    base_url: str | None = None


class LlmProviderPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    base_url: str | None = None
    is_active: bool | None = None


class LlmModelOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str
    provider_id: str
    model_uid: str
    model_name: str
    context_window: int | None = None
    input_price: str | None = None
    output_price: str | None = None
    is_active: bool = True


class LlmModelCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_uid: str
    model_name: str
    context_window: int | None = None
    input_price: str | None = None
    output_price: str | None = None
