"""注册 Wave 0 共享 fixtures（P1-F1~F3 + 身份）到 **整个 tests/integration/ 树**。

放在 `tests/integration/conftest.py`（而非更深的 `fixtures/`）是关键：pytest conftest
作用域只向下传递，放本层后，所有 sibling 子目录（后续 `tests/integration/loops/`、
`tests/integration/cross_tier/` 等三端 Service Integration 测试）都能直接消费
`tenant_scope` / `manager_owner` / `seeded_enterprise` 等，无需各自再注册——这正是
"共享测试底座"的目标（sibling 可见性回归见 `_foundation_consumers/`）。

把各 fixture 模块里的 @pytest.fixture 函数导入 conftest 命名空间即完成注册。
"""

from __future__ import annotations

import pytest

from tests.integration.fixtures.data_lifecycle import seeded_enterprise  # noqa: F401
from tests.integration.fixtures.identities import (  # noqa: F401
    agent_user,
    bad_service_token_headers,
    cross_tenant_actor,
    manager_member,
    manager_owner,
    operator_admin,
    service_token,
    service_token_headers,
)
from tests.integration.fixtures.manager_binding import bind_manager_app  # noqa: F401
from tests.integration.fixtures.postgres import (  # noqa: F401
    migrated_pg,
    pg_admin_url,
    pg_business_url,
    tenant_scope,
    tenant_scope_factory,
)


@pytest.fixture(autouse=True)
def _bind_shared_manager_app(request):
    """Bind the legacy module app to the test's explicit tenant scope.

    This is a test-harness adapter only. It lets older integration modules reuse
    one imported FastAPI object without making production Manager discover or serve
    multiple tenants. Tests that provision a different deployment tenant must call
    ``bind_manager_app`` themselves before the request.
    """
    names = set(request.fixturenames)
    if not {"tenant_scope", "seeded_enterprise"} & names:
        yield
        return

    scope = request.getfixturevalue("tenant_scope")
    from manager_service import app as manager_module

    manager_app = manager_module.app
    old_settings = manager_app.state.settings
    old_ready = getattr(manager_app.state, "_manager_binding_ready", False)
    verifier = getattr(manager_module, "_verifier", None)
    old_verifier_tenant = getattr(verifier, "_deployment_tenant_id", None)
    bind_manager_app(scope.tenant_id, manager_app)
    try:
        yield
    finally:
        manager_app.state.settings = old_settings
        manager_app.state._manager_binding_ready = old_ready
        if verifier is not None and hasattr(verifier, "_deployment_tenant_id"):
            verifier._deployment_tenant_id = old_verifier_tenant
