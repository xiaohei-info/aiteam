"""Hindsight Agent lease wire contract.

The upstream Hindsight 0.12 API accepts one bearer API key for the service and
has no bank-scoped token primitive. These schemas therefore describe the
Manager-issued, short-lived *facade lease*, not a native Hindsight credential.
The lease token is returned only by the protected runtime-config endpoint.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class HindsightRuntimeConfigRequest(BaseModel):
    """Request a lease for the employee selected by Manager snapshot auth."""

    model_config = ConfigDict(extra="forbid")

    employee_id: str = Field(min_length=1, max_length=256)
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


class HindsightLeaseRevocationOut(BaseModel):
    """Non-secret result of a lease revoke/rotation operation."""

    model_config = ConfigDict(extra="forbid")

    lease_id: str = Field(min_length=1, max_length=128)
    bank_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    status: str = Field(pattern="^(revoked|expired)$")
    revoked_at: datetime
