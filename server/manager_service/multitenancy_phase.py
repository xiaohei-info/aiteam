"""Stage A control-plane write gate; not a process tenant binding.

F01/F02/F17 stay fail-closed until Stage B/C/E isolate RAG workspaces,
enterprise login, and background jobs. Existing provisioned-tenant login
does not use this gate.
"""
from shared.errors import AppError

PHASE_PENDING_CODE = "multitenancy_phase_pending"


class MultitenancyPhasePending(AppError):
    status, code, title = 503, PHASE_PENDING_CODE, "Multitenancy Phase Pending"


_DETAIL = (
    "Control-plane tenant writes (F01/F02/F17) are unavailable until Manager "
    "RAG workspace isolation, enterprise login, and background job isolation complete"
)


def require_control_plane_writes_ready() -> None:
    raise MultitenancyPhasePending(_DETAIL)
