"""Team run stream router tests."""

from agent_gateway.event_hydrator import get_hydrator
from team_panel.api_team import router_team


class _NoCursorConnection:
    def cursor(self):
        raise AssertionError("active live stream routing must not query the DB")


def test_active_run_stream_returns_live_sentinel_without_db_read():
    run_id = "run_active_router"
    hydrator = get_hydrator()
    hydrator.remove_stream(run_id)
    hydrator.register_stream(run_id)
    try:
        status, body, content_type = router_team._handle_run_stream(
            _NoCursorConnection(),
            f"/api/team/runs/{run_id}/stream",
            run_id,
            "cursor=not-an-int",
        )

        assert status == 200
        assert body == router_team._SSE_LIVE_SENTINEL
        assert content_type == "text/event-stream"
    finally:
        hydrator.remove_stream(run_id)
