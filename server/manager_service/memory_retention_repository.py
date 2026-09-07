"""Tenant-scoped acceptance/cleanup metadata; never memory text or HTTP payloads."""
from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict

COLUMNS = ("tenant_id", "employee_id", "member_id", "bank_id", "document_id", "operation_id",
           "policy_revision", "accepted_at", "expires_at", "operation_state", "terminal_at",
           "cleanup_state", "claim_owner", "claim_until", "attempts", "next_attempt", "last_error_code", "last_batch_sha256")
SELECT = ",".join(COLUMNS)


def _row(row):
    if row is None:
        return None
    result = dict(zip(COLUMNS, row))
    for key in ("tenant_id", "employee_id", "member_id", "operation_id"):
        result[key] = str(result[key])
    return result


class MemoryRetentionRepository:
    def __init__(self, router: PgTenantRouter, admin_dsn: str | None = None):
        self._router = router
        self._admin_dsn = admin_dsn

    def accept(self, ctx, *, employee_id, bank_id, document_id, operation_id, policy):
        with self._router.session(ctx) as s:
            current = s.execute("SELECT revision FROM employee_memory_setting WHERE employee_id=%s FOR UPDATE", (employee_id,)).fetchone()
            if current is None or current[0] != int(policy.get("revision", 0)):
                raise Conflict("Memory policy changed before acceptance")
            row = s.execute(
                "INSERT INTO memory_acceptance (tenant_id,employee_id,member_id,bank_id,document_id,operation_id,policy_revision,expires_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s::integer IS NULL THEN NULL ELSE now()+%s*interval '1 day' END) "
                "ON CONFLICT(tenant_id,bank_id,document_id) DO UPDATE SET document_id=EXCLUDED.document_id RETURNING " + SELECT,
                (ctx.tenant_id, employee_id, ctx.user_id, bank_id, document_id, operation_id,
                 int(policy.get("revision", 0)), policy.get("retention_days"), policy.get("retention_days")),
            ).fetchone()
            result = _row(row)
            if result["employee_id"] != employee_id or result["member_id"] != ctx.user_id or result["operation_id"] != operation_id:
                raise Conflict("Memory acceptance scope conflict")
            if result["expires_at"] is not None:
                s.execute("INSERT INTO memory_bank_guard(tenant_id,employee_id,bank_id,source) "
                          "VALUES(%s,%s,%s,'manager_acceptance') ON CONFLICT DO NOTHING",
                          (ctx.tenant_id, employee_id, bank_id))
        return result

    def get(self, ctx, *, bank_id, document_id):
        with self._router.session(ctx) as s:
            return _row(s.execute("SELECT " + SELECT + " FROM memory_acceptance WHERE bank_id=%s AND document_id=%s",
                                  (bank_id, document_id)).fetchone())

    def tenant_ids_due(self, tenant_id: str | None = None):
        """Return due tenants for an explicit tenant_id. Stage A does not inventory all tenants."""
        if not tenant_id or self._admin_dsn is None:
            return []
        import psycopg
        with psycopg.connect(self._admin_dsn) as c:
            rows = c.execute(
                "SELECT tenant_id FROM memory_acceptance WHERE tenant_id=%s "
                "AND next_attempt<=now() AND cleanup_state<>'cleaned' "
                "AND (claim_until IS NULL OR claim_until<=now()) "
                "GROUP BY tenant_id ORDER BY MIN(next_attempt) LIMIT 1",
                (tenant_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def claim(self, ctx: TenantContext, *, owner: str):
        with self._router.session(ctx) as s:
            row = s.execute(
                "WITH candidate AS (SELECT tenant_id,bank_id,document_id FROM memory_acceptance "
                "WHERE next_attempt<=now() AND cleanup_state<>'cleaned' AND (claim_until IS NULL OR claim_until<=now()) "
                "ORDER BY next_attempt LIMIT 1 FOR UPDATE SKIP LOCKED) "
                "UPDATE memory_acceptance a SET claim_owner=%s,claim_until=now()+interval '60 seconds',attempts=attempts+1 "
                "FROM candidate c WHERE a.tenant_id=c.tenant_id AND a.bank_id=c.bank_id AND a.document_id=c.document_id "
                "RETURNING " + ",".join("a."+key for key in COLUMNS), (owner,),
            ).fetchone()
        return _row(row)

    def owned(self, ctx, job, owner):
        with self._router.session(ctx) as s:
            return bool(s.execute("SELECT 1 FROM memory_acceptance WHERE bank_id=%s AND document_id=%s "
                                  "AND operation_id=%s AND claim_owner=%s AND claim_until>now()",
                                  (job["bank_id"], job["document_id"], job["operation_id"], owner)).fetchone())

    def finish(self, ctx, job, *, owner, operation_state, cleanup_state, next_attempt, error=None, batch_sha256=None):
        with self._router.session(ctx) as s:
            s.execute(
                "UPDATE memory_acceptance SET operation_state=%s,terminal_at=CASE WHEN %s IN ('completed','failed','cancelled') "
                "THEN COALESCE(terminal_at,now()) ELSE terminal_at END,cleanup_state=%s, "
                "next_attempt=CASE WHEN expires_at IS DISTINCT FROM %s::timestamptz THEN LEAST(%s,expires_at) ELSE %s END, "
                "last_error_code=%s,last_batch_sha256=COALESCE(%s,last_batch_sha256),claim_owner=NULL,claim_until=NULL WHERE bank_id=%s AND document_id=%s "
                "AND operation_id=%s AND claim_owner=%s AND claim_until>now()",
                (operation_state, operation_state, cleanup_state, job["expires_at"], next_attempt, next_attempt, error, batch_sha256,
                 job["bank_id"], job["document_id"], job["operation_id"], owner),
            )

    def settled(self, ctx, job, *, owner, state):
        """Persist terminal proof for this claimed generation, never another worker's job."""
        if state not in {"completed", "failed", "cancelled"}:
            return False
        with self._router.session(ctx) as s:
            return bool(s.execute(
                "UPDATE memory_acceptance SET operation_state=%s,terminal_at=COALESCE(terminal_at,now()) "
                "WHERE bank_id=%s AND document_id=%s AND operation_id=%s AND claim_owner=%s AND claim_until>now() "
                "AND (terminal_at IS NULL OR operation_state=%s) RETURNING 1",
                (state, job["bank_id"], job["document_id"], job["operation_id"], owner, state),
            ).fetchone())
