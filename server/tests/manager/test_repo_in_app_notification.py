"""in_app_notification_repository.py 单元测试（FakeRouter，无 PG 依赖）。"""

from __future__ import annotations

from datetime import datetime

from manager_service.in_app_notification_repository import (
    InAppNotificationRepository,
    InAppNotificationRow,
    build_in_app_notification_repository,
)

from ._fake_router import FakeCursor, FakeRouter, ctx


def _row(nid="n-1", tid="t-1", org="o-1", msg="hello", ntype="operation_announcement",
          severity="info", read=False, created=None):
    return (nid, tid, org, msg, ntype, severity, read, created or datetime(2026, 1, 10, 12, 0, 0))


def test_add_returns_row():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_row()))
    repo = InAppNotificationRepository(router)
    row = repo.add(ctx(), org_id="o-1", message="hello", notify_type="operation_announcement", severity="info")
    assert isinstance(row, InAppNotificationRow)
    assert row.notification_id == "n-1"
    assert row.tenant_id == "t-1"
    assert row.message == "hello"
    assert row.notify_type == "operation_announcement"


def test_add_passes_tenant_id_from_ctx():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_row(tid="t-9")))
    InAppNotificationRepository(router).add(
        ctx(tid="t-9"), org_id="o-1", message="m", notify_type="operation_announcement", severity="info",
    )
    sql, params = router.executed[0]
    assert "in_app_notification" in sql
    assert params[0] == "t-9"
    assert params[1] == "o-1"
    assert params[2] == "m"


def test_add_idempotent_keeps_message_out_of_receipt_and_reloads_projection():
    router = FakeRouter()
    row = _row(msg="private notification")
    router.queue_many(
        FakeCursor(fetchone=("fp", "pending", None)),
        FakeCursor(fetchone=row),
        FakeCursor(rowcount=1),
        FakeCursor(fetchone=row),
    )
    notification = InAppNotificationRepository(router).add_idempotent(
        ctx(),
        org_id="o-1",
        message="private notification",
        notify_type="operation_announcement",
        severity="info",
        idempotency_key="f17-1",
        request_fingerprint="fp",
    )
    assert notification.message == "private notification"
    receipt_update = router.executed[2]
    assert "private notification" not in str(receipt_update[1])
    assert receipt_update[1][0] == '{"notification_id": "n-1"}'


def test_add_idempotent_replay_loads_notification_by_opaque_id():
    router = FakeRouter()
    row = _row(msg="replayed body")
    router.queue_many(
        FakeCursor(fetchone=None),
        FakeCursor(fetchone=("fp", "completed", '{"notification_id": "n-1"}')),
        FakeCursor(fetchone=row),
    )
    notification = InAppNotificationRepository(router).add_idempotent(
        ctx(),
        org_id="o-1",
        message="ignored on replay",
        notify_type="operation_announcement",
        severity="info",
        idempotency_key="f17-1",
        request_fingerprint="fp",
    )
    assert notification.message == "replayed body"
    assert all("ignored on replay" not in str(params) for _, params in router.executed)


def test_list_all_returns_rows_desc():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_row("n1"), _row("n2", msg="second")]))
    rows = InAppNotificationRepository(router).list_all(ctx())
    assert len(rows) == 2


def test_list_all_empty():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[]))
    rows = InAppNotificationRepository(router).list_all(ctx())
    assert rows == []


def test_build_factory():
    assert isinstance(build_in_app_notification_repository(FakeRouter()), InAppNotificationRepository)
