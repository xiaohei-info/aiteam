from __future__ import annotations

from tests.aiteam.layer0_contracts.test_host_routing import _get


def _normalize_office_payload(scene: dict, feed: dict) -> dict | None:
    summary = scene.get("summary")
    seats = scene.get("seats")
    items = feed.get("items")
    if not isinstance(summary, dict) or not isinstance(seats, list) or not isinstance(items, list):
        return None
    if len(seats) == 0:
        return None
    required_summary = {"online_employee_count", "running_task_count"}
    if not required_summary.issubset(summary):
        return None
    for seat in seats:
        presence = seat.get("presence")
        if not {"employee_id", "display_name", "role_name", "presence"}.issubset(seat):
            return None
        if not isinstance(presence, dict):
            return None
        if not {"state", "current_task", "latest_event_cursor"}.issubset(presence):
            return None
    for item in items:
        if not {"run_id", "employee_id", "employee_display_name", "preview", "status", "display_state", "latest_event_cursor"}.issubset(item):
            return None
    return {"summary": summary, "seats": seats, "items": items}


def test_office_scene_returns_consumable_shape(seeded_enterprise):
    status, body = _get("/api/team/office/scene")
    assert status == 200, body
    assert {"enterprise_id", "generated_at", "generated_cursor", "refresh_hint_ms", "summary", "seats"}.issubset(body)
    assert body["summary"]["online_employee_count"] >= 1
    assert "running_task_count" in body["summary"]
    assert isinstance(body["seats"], list)
    assert body["seats"], body
    seat = body["seats"][0]
    for key in ("employee_id", "display_name", "role_name", "presence"):
        assert key in seat, seat
    presence = seat["presence"]
    for key in ("state", "current_task", "latest_event_cursor"):
        assert key in presence, presence


def test_office_feed_returns_consumable_shape(seeded_enterprise):
    status, body = _get("/api/team/office/feed")
    assert status == 200, body
    assert {"enterprise_id", "generated_at", "generated_cursor", "refresh_hint_ms", "items", "queue", "billing_snapshot"}.issubset(body)
    assert isinstance(body["items"], list)
    if body["items"]:
        item = body["items"][0]
        for key in ("run_id", "employee_id", "employee_display_name", "preview", "status", "display_state", "latest_event_cursor"):
            assert key in item, item


def test_office_payload_matches_frontend_normalization_semantics(seeded_enterprise):
    scene_status, scene = _get("/api/team/office/scene")
    feed_status, feed = _get("/api/team/office/feed")
    assert scene_status == 200, scene
    assert feed_status == 200, feed
    normalized = _normalize_office_payload(scene, feed)
    assert normalized is not None
    assert normalized["summary"]["online_employee_count"] >= 1
    assert len(normalized["seats"]) >= 1
