"""Connector operation orchestration (B05).

Local validation replaces the old "always-success mock" (issue #296):
managers record connector test results and status based on REAL local validation
(connector_id semantics + auth_scheme enum + config_schema_json parse). Real
outbound connectivity is still deferred to the user-side executor per D18 — but
the operator now gets observable, actionable feedback instead of a stub.
"""

from __future__ import annotations

import time

from shared.contracts.tenancy import TenantContext

from .connector_ops_repository import ConnectorOpsRepository
from .connector_probe import validate_connector


class ConnectorOpsService:
    def __init__(self, repo: ConnectorOpsRepository):
        self._repo = repo

    def get_status(self, ctx: TenantContext, connector_id: str) -> dict:
        row = self._repo.get_status(ctx, connector_id)
        if row is None:
            return {"connector_id": connector_id, "status": "disconnected",
                    "last_check_at": None, "error_message": None}
        return {
            "connector_id": row.connector_id, "status": row.status,
            "last_check_at": row.last_check_at, "error_message": row.error_message,
        }

    def test_connector(
        self,
        ctx: TenantContext,
        connector_id: str,
        *,
        auth_scheme: str | None = None,
        config_schema_json: str | dict | None = None,
    ) -> dict:
        # Real local validation: connector_id + auth_scheme + config_schema_json.
        # D18: no outbound connector-API calls here; only admin-face validation.
        t0 = time.time()
        probe = validate_connector(connector_id, auth_scheme=auth_scheme,
                                   config_schema_json=config_schema_json)
        latency_ms = max(1, int((time.time() - t0) * 1000))

        self._repo.create_test(
            ctx, connector_id,
            success=probe.success,
            latency_ms=latency_ms,
            message=probe.message,
        )
        self._repo.upsert_status(
            ctx, connector_id,
            status="connected" if probe.success else "error",
            error_message=None if probe.success else probe.message,
        )
        return {
            "connector_id": connector_id,
            "success": probe.success,
            "latency_ms": latency_ms,
            "message": probe.message,
            "auth_scheme": probe.auth_scheme,
            "flow": probe.flow,
        }

    def get_grants(self, ctx: TenantContext, connector_id: str) -> dict:
        row = self._repo.get_grants(ctx, connector_id)
        if row is None:
            return {"connector_id": connector_id, "employee_ids": []}
        return {"connector_id": row.connector_id, "employee_ids": row.employee_ids}

    def set_grants(self, ctx: TenantContext, connector_id: str, employee_ids: list[str], action: str) -> dict:
        current = self._repo.get_grants(ctx, connector_id)
        if action == "revoke":
            if current:
                remaining = set(current.employee_ids) - set(employee_ids)
                employee_ids = list(remaining)
            else:
                employee_ids = []
        else:
            if current:
                merged = set(current.employee_ids) | set(employee_ids)
                employee_ids = list(merged)
        row = self._repo.set_grants(ctx, connector_id, employee_ids)
        return {"connector_id": row.connector_id, "employee_ids": row.employee_ids, "action": action, "updated": True}
