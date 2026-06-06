"""UsageLedger repository."""
from typing import Optional

from ..domain.entities import UsageLedger


class UsageLedgerRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, ledger: UsageLedger) -> UsageLedger:
        self._cur.execute(
            "INSERT INTO usage_ledger (id, enterprise_id, employee_id, conversation_id, run_id, input_tokens, output_tokens, "
            "total_tokens, cost_cents, source_type, occurred_at, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(NULLIF(%s, '')::timestamptz, now()), %s, %s)",
            (
                ledger.id,
                ledger.enterprise_id,
                ledger.employee_id,
                ledger.conversation_id,
                ledger.run_id,
                ledger.input_tokens,
                ledger.output_tokens,
                ledger.total_tokens,
                ledger.cost_cents,
                ledger.source_type,
                ledger.occurred_at,
                ledger.created_by or None,
                ledger.updated_by or None,
            ),
        )
        return ledger

    def upsert(self, ledger: UsageLedger) -> UsageLedger:
        self._cur.execute(
            "INSERT INTO usage_ledger (id, enterprise_id, employee_id, conversation_id, run_id, input_tokens, output_tokens, "
            "total_tokens, cost_cents, source_type, occurred_at, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(NULLIF(%s, '')::timestamptz, now()), %s, %s) "
            "ON CONFLICT (run_id, source_type) DO UPDATE SET "
            "employee_id=EXCLUDED.employee_id, conversation_id=EXCLUDED.conversation_id, input_tokens=EXCLUDED.input_tokens, "
            "output_tokens=EXCLUDED.output_tokens, total_tokens=EXCLUDED.total_tokens, cost_cents=EXCLUDED.cost_cents, "
            "occurred_at=EXCLUDED.occurred_at, updated_at=now(), updated_by=EXCLUDED.updated_by",
            (
                ledger.id,
                ledger.enterprise_id,
                ledger.employee_id,
                ledger.conversation_id,
                ledger.run_id,
                ledger.input_tokens,
                ledger.output_tokens,
                ledger.total_tokens,
                ledger.cost_cents,
                ledger.source_type,
                ledger.occurred_at,
                ledger.created_by or None,
                ledger.updated_by or None,
            ),
        )
        return ledger

    def get_by_run_and_source(self, run_id: str, source_type: str) -> Optional[UsageLedger]:
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, conversation_id, run_id, input_tokens, output_tokens, total_tokens, "
            "cost_cents, source_type, occurred_at, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM usage_ledger WHERE run_id = %s AND source_type = %s AND deleted_at IS NULL",
            (run_id, source_type),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return self._row_to_entity(row)

    def list_by_enterprise(self, enterprise_id: str, *, period_start: str | None = None, period_end: str | None = None) -> list[UsageLedger]:
        clauses = ["enterprise_id = %s", "deleted_at IS NULL"]
        params: list[object] = [enterprise_id]
        if period_start:
            clauses.append("occurred_at >= %s::timestamptz")
            params.append(period_start)
        if period_end:
            clauses.append("occurred_at < %s::timestamptz")
            params.append(period_end)
        self._cur.execute(
            "SELECT id, enterprise_id, employee_id, conversation_id, run_id, input_tokens, output_tokens, total_tokens, "
            "cost_cents, source_type, occurred_at, created_at, updated_at, created_by, updated_by, deleted_at "
            f"FROM usage_ledger WHERE {' AND '.join(clauses)} ORDER BY occurred_at DESC, id DESC",
            tuple(params),
        )
        return [self._row_to_entity(row) for row in self._cur.fetchall()]

    @staticmethod
    def _row_to_entity(row) -> UsageLedger:
        return UsageLedger(
            id=row[0],
            enterprise_id=row[1],
            employee_id=row[2],
            conversation_id=row[3],
            run_id=row[4],
            input_tokens=row[5],
            output_tokens=row[6],
            total_tokens=row[7],
            cost_cents=row[8],
            source_type=row[9],
            occurred_at=str(row[10]),
            created_at=str(row[11]),
            updated_at=str(row[12]),
            created_by=row[13] or "",
            updated_by=row[14] or "",
            deleted_at=str(row[15]) if row[15] else None,
        )
