"""Operator-owned platform Provider/model/rate contracts (D18, 04 §6.7)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PlatformModelRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    provider_version: int = Field(ge=1)
    model_id: str
    model_version: int = Field(ge=1)


class PlatformProvider(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    provider_code: str
    display_name: str
    relay_base_url: str
    api_protocol: Literal["openai-completions", "openai-responses", "anthropic-messages"]
    status: Literal["draft", "published", "disabled"]
    version: int = Field(ge=1)
    updated_at: datetime


class PlatformModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    model_id: str
    display_name: str = ""
    capabilities: dict = Field(default_factory=dict)
    status: Literal["draft", "published", "disabled"]
    source: Literal["discovery", "manual"] = "discovery"
    version: int = Field(ge=1)
    updated_at: datetime


class PlatformModelRate(BaseModel):
    """Immutable USD rate version. Decimal fields are serialized as strings."""

    model_config = ConfigDict(extra="forbid")

    rate_id: str
    provider_id: str
    model_id: str
    pricing_version: int = Field(ge=1)
    pricing_status: Literal["known", "unknown"]
    billing_mode: Literal["token", "request"] = "token"
    input_usd_per_million: Decimal | None = Field(default=None, ge=0)
    output_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_read_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_write_usd_per_million: Decimal | None = Field(default=None, ge=0)
    request_usd: Decimal | None = Field(default=None, ge=0)
    currency: Literal["USD"] = "USD"
    source: Literal["manual", "provider", "public_reference", "unknown"]
    source_version: str | None = None
    effective_from: datetime
    effective_to: datetime | None = None
    manually_overridden: bool = False


class PricingSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pricing_version: int = Field(ge=1)
    pricing_status: Literal["known", "unknown"]
    billing_mode: Literal["token", "request"] = "token"
    input_usd_per_million: Decimal | None = Field(default=None, ge=0)
    output_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_read_usd_per_million: Decimal | None = Field(default=None, ge=0)
    cache_write_usd_per_million: Decimal | None = Field(default=None, ge=0)
    request_usd: Decimal | None = Field(default=None, ge=0)
    currency: Literal["USD"] = "USD"
    effective_from: datetime


class TenantProviderAccess(BaseModel):
    """Public metadata only; the Relay token is never part of catalog responses."""

    model_config = ConfigDict(extra="forbid")

    access_id: str
    tenant_id: str
    provider_id: str
    allowed_model_ids: list[str]
    status: Literal["active", "revoked"]
    version: int = Field(ge=1)
    expires_at: datetime | None = None
