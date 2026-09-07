"""Hindsight Agent lease wire contract.

The upstream Hindsight 0.12 API accepts one bearer API key for the service and
has no bank-scoped token primitive. These schemas therefore describe the
Manager-issued, short-lived *facade lease*, not a native Hindsight credential.
The lease token is returned only by the protected runtime-config endpoint.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


HINDSIGHT_CLIENT_PROTOCOL = "aiteam-memory-v1"


class HindsightRuntimeConfigRequest(BaseModel):
    """Request a lease for the employee selected by Manager snapshot auth."""

    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1, max_length=256)
    client_protocol: str | None = Field(
        default=None,
        max_length=64,
        description="Controlled-client protocol; current value is aiteam-memory-v1. Missing/unknown values receive read-only scope or an upgrade-required error; this is not proof of human intent.",
        examples=["aiteam-memory-v1", None],
    )
    rotate: bool = Field(
        default=False,
        description="Revoke the current lease for this employee before issuing a new one",
    )


class HindsightRuntimeConfigOut(BaseModel):
    """Minimal ephemeral Agent config.

    ``token`` is an opaque Manager-facade bearer and is not a native Hindsight
    bank token. It must never be copied into snapshots, SQLite, Pi sessions,
    SSE, logs, or durable Agent configuration.
    """

    model_config = ConfigDict(extra="forbid")

    base_url: str = Field(min_length=1, description="Manager Hindsight facade URL")
    bank_id: str = Field(min_length=1, max_length=128)
    token: str = Field(
        min_length=1, repr=False, description="Short-lived opaque facade lease token"
    )
    lease_id: str = Field(min_length=1, max_length=128)
    version: int = Field(
        ge=1, description="Monotonic lease version for this tenant/member/employee"
    )
    issued_at: datetime
    expires_at: datetime
    allowed_operations: list[Literal["recall", "retain"]] = Field(
        max_length=2,
        description="Manager 当前允许的 Hindsight 操作；仅 recall/retain，空列表表示拒绝。",
        examples=[["recall"], ["recall", "retain"]],
    )
    policy_revision: int = Field(
        ge=0,
        description="当前 employee memory policy revision；写 lease 必须为正整数并与策略一致。",
    )
    client_protocol: Literal["aiteam-memory-v1"] | None = Field(
        description="Manager-confirmed client protocol; no write lease without confirmation.",
        examples=["aiteam-memory-v1", None],
    )
    explicit_auto_retain: bool = Field(strict=True, description="Current Manager auto-retain consent. Intersect with snapshot permission; missing is never consent.")
    retention_mode: Literal["unlimited", "fact_only"] = Field(
        description="Finite policy uses provenance-verified facts only; fact_only is not hard erasure.",
        examples=["unlimited", "fact_only"],
    )


class HindsightLeaseRevocationOut(BaseModel):
    """Non-secret result of a lease revoke/rotation operation."""

    model_config = ConfigDict(extra="forbid")

    lease_id: str = Field(min_length=1, max_length=128)
    bank_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    status: str = Field(pattern="^(revoked|expired)$")
    revoked_at: datetime
