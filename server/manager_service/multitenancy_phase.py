"""Stage A control-plane write gate; not a process tenant binding.

F01/F02/F17 stay fail-closed until Stage B/C/E isolate RAG workspaces,
enterprise login, and background jobs. Existing provisioned-tenant login
does not use this gate.
"""

from __future__ import annotations

from shared.errors import AppError

PHASE_PENDING_CODE = "multitenancy_phase_pending"


class MultitenancyPhasePending(AppError):
    status, code, title = 503, PHASE_PENDING_CODE, "Multitenancy Phase Pending"


_DETAIL = (
    "Control-plane tenant writes (F01/F02/F17) are unavailable until Manager "
    "RAG workspace isolation, enterprise login, and background job isolation complete"
)


def test_onboarding_writes_enabled(settings) -> bool:
    """Return the typed, TEST-only onboarding verification switch."""
    return bool(
        getattr(settings, "aiteam_env", None) == "test"
        and getattr(settings, "test_onboarding_writes_enabled", False)
    )


def require_control_plane_writes_ready(settings=None) -> None:
    """Keep the gate closed except for an explicit typed TEST opt-in."""
    if settings is not None and test_onboarding_writes_enabled(settings):
        return
    raise MultitenancyPhasePending(_DETAIL)
