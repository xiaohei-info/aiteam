"""Layer2 Team Panel — system-admin enterprise account management API tests.

RED-GREEN-REFACTOR TDD: system-admin list/search/detail/actions/quota/export.
"""
from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest

# Reuse the test helpers from team API contract tests
try:
    from tests.aiteam.layer2_team_panel.test_team_api_contracts import _get, _post, _FakeHandler
except ImportError:
    class _FakeHandler:
        def __init__(self):
            self.status = None
            self.sent_headers: list[tuple[str, str]] = []
            self.body = bytearray()
            self.wfile = self
            self.headers = {}

        def send_response(self, code):
            self.status = code

        def send_header(self, key, value):
            self.sent_headers.append((key, value))

        def end_headers(self):
            pass

        def write(self, data):
            self.body.extend(data if isinstance(data, (bytes, bytearray)) else data.encode("utf-8"))

        def get_json(self):
            return json.loads(self.body.decode("utf-8")) if self.body else {}


    def _get(parsed_path: str) -> tuple[int, dict]:
        from api.routes import handle_get
        handler = _FakeHandler()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_get(handler, parsed)
        return handler.status, handler.get_json()


    def _post(parsed_path: str, body: dict | None = None) -> tuple[int, dict]:
        from api.routes import handle_post
        handler = _FakeHandler()
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            handler.headers["Content-Length"] = str(len(raw))
            handler.rfile = type("_BytesIO", (), {"read": lambda n: raw})()
        parsed = urlparse(f"http://example.com{parsed_path}")
        handle_post(handler, parsed)
        return handler.status, handler.get_json()


def _system_admin_path(path: str) -> str:
    separator = "&" if "?" in path else "?"
    return f"{path}{separator}role=system_admin"


# ═══════════════════════════════════════════════════════════════════
# T01: List enterprises
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminListEnterprises:
    def test_list_enterprises_returns_200(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/enterprises"))
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_list_enterprises_has_pagination_shape(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises"))
        for key in ("enterprises", "total", "page", "limit", "has_more"):
            assert key in body, f"Missing {key} in response: {body}"

    def test_list_enterprises_includes_seeded(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises"))
        assert body.get("total", 0) >= 1
        ids = [e.get("id") or e.get("enterprise_id") for e in body.get("enterprises", [])]
        assert seeded_enterprise["enterprise_id"] in ids


# ═══════════════════════════════════════════════════════════════════
# T02: Search enterprises
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminSearchEnterprises:
    def test_search_by_name_returns_matching(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises?name=Test"))
        assert body.get("total", 0) >= 1

    def test_search_by_name_no_match_returns_empty(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises?name=ZZZ_NO_MATCH_ZZZ"))
        assert body.get("total", 0) == 0

    def test_filter_by_status_active(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises?status=active"))
        assert body.get("total", 0) >= 1

    def test_filter_by_status_archived_returns_empty(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises?status=archived"))
        # No archived enterprises in seed data
        assert body.get("total", 0) == 0

    def test_filter_by_created_range_returns_matching_enterprise(self, seeded_enterprise):
        _, body = _get(
            _system_admin_path(
                "/api/system-admin/enterprises?created_from=2026-01-01&created_to=2099-12-31"
            )
        )
        ids = [item["id"] for item in body["enterprises"]]
        assert seeded_enterprise["enterprise_id"] in ids

    def test_filter_by_created_range_excludes_out_of_window(self, seeded_enterprise):
        _, body = _get(
            _system_admin_path(
                "/api/system-admin/enterprises?created_from=2099-01-01&created_to=2099-12-31"
            )
        )
        assert body["total"] == 0


# ═══════════════════════════════════════════════════════════════════
# T03: Enterprise detail
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminEnterpriseDetail:
    def test_get_detail_returns_200(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}"))
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_detail_has_expected_fields(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        _, body = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}"))
        for key in ("id", "name", "slug", "status"):
            assert key in body, f"Missing {key} in detail: {body}"

    def test_get_detail_missing_returns_404(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/enterprises/nonexistent-999"))
        assert status == 404


# ═══════════════════════════════════════════════════════════════════
# T04: Enterprise actions
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminEnterpriseActions:
    def _action_path(self, enterprise_id: str, suffix: str = "/actions") -> str:
        return (
            f"/api/system-admin/enterprises/{enterprise_id}{suffix}"
            "?role=system_admin&actor_id=usr_sys"
        )

    def test_ban_action_returns_200(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(
            self._action_path(ent_id),
            {"action": "ban", "reason": "policy violation"},
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise_id"] == ent_id
        assert body["action"] == "ban"
        assert body["status"] == "succeeded"
        assert body["message"]
        assert "audit_event_id" in body

    def test_ban_action_changes_status_to_suspended(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        _post(
            self._action_path(ent_id),
            {"action": "ban", "reason": "policy violation"},
        )
        _, body = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}"))
        assert body.get("status") == "suspended", f"Expected suspended, got {body}"

    def test_unban_action_restores_active_status(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        _post(
            self._action_path(ent_id),
            {"action": "ban", "reason": "policy violation"},
        )

        status, body = _post(
            self._action_path(ent_id),
            {"action": "unban", "reason": "review cleared"},
        )

        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise_id"] == ent_id
        assert body["action"] == "unban"
        assert body["status"] == "succeeded"
        assert body["message"]

        _, detail = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}"))
        assert detail.get("status") == "active", f"Expected active, got {detail}"

    def test_recharge_action_returns_canonical_shape(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(
            self._action_path(ent_id),
            {"action": "recharge", "amount": 500, "idempotency_key": "sysacct-test-recharge-1"},
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise_id"] == ent_id
        assert body["action"] == "recharge"
        assert body["status"] == "succeeded"
        assert body["message"]
        assert "audit_event_id" in body

    def test_notify_action_records_request_without_status_change(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(
            self._action_path(ent_id),
            {"action": "notify", "message": "Test notification", "idempotency_key": "sysacct-test-notify-1"},
        )
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["enterprise_id"] == ent_id
        assert body["action"] == "notify"
        assert body["status"] == "succeeded"
        assert body["message"]
        assert "audit_event_id" in body

    def test_invalid_action_is_rejected(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(
            self._action_path(ent_id),
            {"action": "freeze"},
        )
        assert status == 400, f"Expected 400, got {status}: {body}"
        assert body["error"] == "INVALID_ACTION"

    def test_recharge_requires_positive_integer_amount(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(
            self._action_path(ent_id),
            {"action": "recharge"},
        )
        assert status == 400, f"Expected 400, got {status}: {body}"
        assert body["error"] == "INVALID_REQUEST"

    def test_legacy_ban_alias_is_kept_as_compatibility_route(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(self._action_path(ent_id, "/ban"))
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["action"] == "ban"
        assert body["status"] == "succeeded"

    def test_legacy_recharge_alias_is_kept_as_compatibility_route(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(self._action_path(ent_id, "/recharge"), {"amount": 1000})
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["action"] == "recharge"
        assert body["status"] == "succeeded"

    def test_legacy_notify_alias_is_kept_as_compatibility_route(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(self._action_path(ent_id, "/notify"), {"message": "Alert", "level": "warning"})
        assert status == 200, f"Expected 200, got {status}: {body}"
        assert body["action"] == "notify"
        assert body["status"] == "succeeded"


# ═══════════════════════════════════════════════════════════════════
# T05: Export enterprises
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminExportEnterprises:
    def test_export_returns_200(self, seeded_enterprise):
        status, body = _get(_system_admin_path("/api/system-admin/enterprises/export"))
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_export_has_items(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises/export"))
        assert "items" in body or "enterprises" in body, f"Missing items: {body}"

    def test_export_filters_by_status(self, seeded_enterprise):
        _, body = _get(_system_admin_path("/api/system-admin/enterprises/export?status=active"))
        assert body.get("total", 0) >= 1


# ═══════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════
# T07: Quota management
# ═══════════════════════════════════════════════════════════════════

class TestSystemAdminQuotaEnterprise:
    def test_get_quota_returns_200(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}/quota"))
        assert status == 200, f"Expected 200, got {status}: {body}"

    def test_get_quota_has_expected_fields(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        _, body = _get(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}/quota"))
        for key in ("employee_quota", "storage_quota_mb", "api_rate_limit"):
            assert key in body, f"Missing {key}: {body}"

    def test_post_quota_returns_200(self, seeded_enterprise):
        ent_id = seeded_enterprise["enterprise_id"]
        status, body = _post(_system_admin_path(f"/api/system-admin/enterprises/{ent_id}/quota"), {"employee_quota": 100})
        assert status == 200, f"Expected 200, got {status}: {body}"


# ═══════════════════════════════════════════════════════════════════
