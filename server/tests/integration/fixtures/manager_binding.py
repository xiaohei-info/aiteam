"""Explicit binding helpers for Manager integration fixtures.

Production Manager binding is never inferred.  These helpers only reconfigure the
module-level FastAPI app used by the legacy shared integration harness so each test
models one explicitly bound deployment.  Tests that need two deployments must call
``bind_manager_app`` before each client operation instead of using one unbound app.
"""

from __future__ import annotations

from typing import Any

import pytest


# Every Manager route cache below captures either the deployment tenant, a tenant
# router, or a tenant-scoped service.  Keep this explicit so a new test binding
# cannot accidentally reuse a service created for the previous test tenant.
_BINDING_CACHE_NAMES: tuple[str, ...] = (
    "_auth_service",
    "_oauth_service",
    "_passkey_service",
    "_hindsight_facade",
    "_hindsight_runtime_service",
    "_hindsight_lease_store",
    "_memory_retention_service",
    "_knowledge_intake_service",
    "_llm_service",
    "_connector_ops_service",
    "_snapshot_service",
    "_member_services",
    "_provider_credential_service",
    "_crypto_service",
    "_platform_skill_service",
    "_recruit_service",
    "_memory_service",
    "_hindsight_client",
    "_knowledge_space_service",
    "_billing_service",
    "_emp_bind_svc_pv",
    "_emp_bind_svc_sk",
    "_emp_bind_svc_kn",
    "_emp_bind_svc_doc",
    "_emp_bind_svc_mem",
    "_emp_bind_svc_co",
    "_org_service",
    "_usage_audit_quota_service",
    "_settings_service",
    "_employee_config_service",
    "_employee_prompt_service",
    "_capability_catalog_service",
    "_in_app_notification_repo",
    "_authorized_config_service",
    "_audit_service",
)


def _state_mapping(app: Any) -> dict[str, Any]:
    """Return Starlette's actual mutable state mapping for a test app."""
    state = app.state
    mapping = getattr(state, "_state", None)
    if not isinstance(mapping, dict):
        raise TypeError("Manager integration helper requires Starlette State._state")
    return mapping


def clear_binding_caches(app: Any) -> None:
    """Drop all known tenant-bound caches from a shared test Manager app."""
    mapping = _state_mapping(app)
    for name in _BINDING_CACHE_NAMES:
        mapping.pop(name, None)


def bind_manager_app(tenant_id: str, app: Any | None = None):
    """Bind a test Manager app and its captured verifier to ``tenant_id``.

    The production app is assembled once at module import, while integration tests
    reuse that app object for speed.  Pydantic settings are frozen, so the harness
    copies settings and clears request-scoped caches rather than mutating production
    code or enabling an unbound fallback.
    """
    import manager_service.app as manager_module

    manager_app = app or manager_module.app
    clear_binding_caches(manager_app)
    settings = manager_app.state.settings
    manager_app.state.settings = settings.model_copy(update={"manager_tenant_id": str(tenant_id)})
    manager_app.state._manager_binding_ready = True

    # ``manager_router``'s whoami dependency captures the module verifier at route
    # construction time; update that test-only verifier object as well.  Custom
    # routers should inject their own verifier and do not rely on this path.
    verifier = getattr(manager_module, "_verifier", None)
    if verifier is not None and hasattr(verifier, "_deployment_tenant_id"):
        verifier._deployment_tenant_id = str(tenant_id)
        manager_app.state._token_verifier = verifier
    return manager_app


# Tables with tenant-owned rows in the current Manager migrations.  The explicit
# tenant predicate is intentional: this helper is only for fresh test deployments,
# and never issues an unscoped DELETE.  Child/application rows precede the registry
# and signing key rows so failed assertions cannot leave a fresh tenant behind.
_FRESH_TENANT_TABLES: tuple[str, ...] = (
    "knowledge_document_operation",
    "knowledge_document_binding",
    "knowledge_ingestion_job",
    "knowledge_document",
    "employee_knowledge_binding",
    "employee_skill_binding",
    "employee_connector_binding",
    "employee_memory_setting",
    "employee_prompt_history",
    "employee_prompt_version",
    "employee_prompt",
    "memory_acceptance",
    "memory_bank_guard",
    "hindsight_lease",
    "solution_apply_record",
    "recruitment_order",
    "recruit_event",
    "solution_instance",
    "skill_package_revision",
    "skill_catalog",
    "connector_catalog",
    "memory_policy_catalog",
    "connector_grant",
    "connector_test",
    "connector_status",
    "provider_credential",
    "llm_model",
    "llm_provider",
    "collaboration_template",
    "enterprise_settings",
    "admin_invite",
    "billing_balance",
    "recharge_record",
    "usage_rollup",
    "audit_summary_event",
    "enterprise_audit",
    "audit_event",
    "in_app_notification",
    "login_attempt",
    "passkey_credential",
    "oauth_connection",
    "quota_policy",
    "member_grant",
    "department",
    "rag_workspace",
    "knowledge_space_binding",
    "auth_identity",
    "app_user",
    "employee",
    "tenant_signing_key",
    "tenant_registry",
)


def cleanup_fresh_tenant(admin_url: str, tenant_id: str) -> None:
    """Remove only rows belonging to one fresh integration tenant."""
    import psycopg
    from psycopg import sql

    with psycopg.connect(admin_url, autocommit=True) as conn:
        for table in _FRESH_TENANT_TABLES:
            conn.execute(
                sql.SQL("DELETE FROM {} WHERE tenant_id = %s").format(sql.Identifier(table)),
                (tenant_id,),
            )


@pytest.fixture
def fresh_tenant_cleanup(tenant_scope):
    """Register fresh Manager tenants and clean them even on assertion failure."""
    tenant_ids: list[str] = []

    def register(tenant_id: str) -> str:
        tenant_ids.append(str(tenant_id))
        return str(tenant_id)

    yield register
    for tenant_id in reversed(tenant_ids):
        cleanup_fresh_tenant(tenant_scope.admin_url, tenant_id)
