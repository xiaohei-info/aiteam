"""Fake PgTenantRouter/session for repository-layer unit tests (no PG dependency).

Repository methods use ``with self._router.session(ctx) as s: s.execute(sql, params)``
and then call ``.fetchone()/.fetchall()`` or read ``.rowcount`` on the returned cursor.
This module provides a FakeRouter + FakeSession + FakeCursor that let the real
repository code execute against canned results, exercising all branches (None
paths, row mapping, multi-statement methods) without a real PostgreSQL.
"""

from __future__ import annotations

from typing import Any


class FakeCursor:
    """Minimal cursor stub: supports fetchone/fetchall/rowcount."""

    def __init__(
        self,
        *,
        fetchone: tuple | list | None = None,
        fetchall: list[tuple] | None = None,
        rowcount: int | None = None,
    ):
        self._fetchone = fetchone
        self._fetchall = fetchall or []
        if rowcount is not None:
            self.rowcount = rowcount
        elif fetchone is not None:
            self.rowcount = 1
        elif fetchall:
            self.rowcount = len(fetchall)
        else:
            self.rowcount = 0

    def fetchone(self):
        return self._fetchone

    def fetchall(self):
        return list(self._fetchall)


class FakeSession:
    """Context-manager session backed by a queue of FakeCursor results."""

    def __init__(self, router: "FakeRouter", tenant_id: str):
        self._router = router
        self._tenant_id = tenant_id

    @property
    def tenant_id(self) -> str:
        return self._tenant_id

    def execute(self, sql: str, params: Any = None) -> FakeCursor:
        self._router.executed.append((sql, params))
        return self._router._pop()

    def __enter__(self) -> "FakeSession":
        return self

    def __exit__(self, *exc) -> None:
        return None


class FakeRouter:
    """Drop-in for PgTenantRouter in unit tests; returns queued FakeCursors."""

    def __init__(self):
        self._queue: list[FakeCursor] = []
        self.executed: list[tuple[str, Any]] = []

    def session(self, ctx) -> FakeSession:
        return FakeSession(self, ctx.tenant_id)

    def queue(self, cursor: FakeCursor) -> "FakeRouter":
        self._queue.append(cursor)
        return self

    def queue_many(self, *cursors: FakeCursor) -> "FakeRouter":
        self._queue.extend(cursors)
        return self

    def _pop(self) -> FakeCursor:
        if self._queue:
            return self._queue.pop(0)
        return FakeCursor()

    @property
    def last_sql(self) -> str:
        return self.executed[-1][0] if self.executed else ""



_VALID_UUID = "11111111-1111-1111-1111-111111111111"


def ctx(tid: str = _VALID_UUID, *, roles=None, user_id: str = "u-1"):
    """Build a TenantContext for the given tenant."""
    from shared.contracts.tenancy import TenantContext

    return TenantContext(tenant_id=tid, user_id=user_id, roles=roles or ["owner"])
