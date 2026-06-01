"""Team Panel — /api/system-admin/* router."""
from __future__ import annotations

from api.system_health import build_system_health_payload


def _match_exact(path: str, target: str) -> bool:
    return path == target or path.rstrip("/") == target


def handle_team_route(path: str, method: str, body: dict | None = None) -> tuple[int, dict]:
    """Returns (status_code, response_dict)."""
    sub = path[len("/api/system-admin"):] if path.startswith("/api/system-admin") else path
    if not sub:
        sub = "/"

    if method == "GET" and _match_exact(sub, "/health"):
        return 200, build_system_health_payload()

    return 501, {"error": "not_implemented", "message": f"System Admin API not yet implemented: {method} {path}"}
