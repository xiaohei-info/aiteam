"""Explicit binding helpers for Manager integration fixtures.

Production Manager binding is never inferred.  These helpers only reconfigure the
module-level FastAPI app used by the legacy shared integration harness so each test
models one explicitly bound deployment.  Tests that need two deployments must call
``bind_manager_app`` before each client operation instead of using one unbound app.
"""

from __future__ import annotations

from typing import Any


def bind_manager_app(tenant_id: str, app: Any | None = None):
    """Bind a test Manager app and its captured verifier to ``tenant_id``.

    The production app is assembled once at module import, while integration tests
    reuse that app object for speed.  Pydantic settings are frozen, so the harness
    copies settings and clears request-scoped caches rather than mutating production
    code or enabling an unbound fallback.
    """
    import manager_service.app as manager_module

    manager_app = app or manager_module.app
    settings = manager_app.state.settings
    manager_app.state.settings = settings.model_copy(update={"manager_tenant_id": str(tenant_id)})
    manager_app.state._manager_binding_ready = True
    for name in (
        "_auth_service",
        "_oauth_service",
        "_passkey_service",
        "_hindsight_facade",
        "_memory_retention_service",
        "_knowledge_intake_service",
    ):
        manager_app.state.__dict__.pop(name, None)

    # ``manager_router``'s whoami dependency captures the module verifier at route
    # construction time; update that test-only verifier object as well.  Custom
    # routers should inject their own verifier and do not rely on this path.
    verifier = getattr(manager_module, "_verifier", None)
    if verifier is not None and hasattr(verifier, "_deployment_tenant_id"):
        verifier._deployment_tenant_id = str(tenant_id)
        manager_app.state._token_verifier = verifier
    return manager_app
