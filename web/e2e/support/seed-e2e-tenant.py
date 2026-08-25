#!/usr/bin/env python3
"""Prepare the run-scoped Manager tenant used by browser E2E.

The seed is deliberately fail-closed: a local cross-tier run must have a real test
provider configuration.  The provider secret is read only from the process
environment, encrypted before it reaches PostgreSQL, and never included in output.

Required provider environment:
  E2E_PROVIDER_ENDPOINT  provider/relay URL used by the E2E runtime
  E2E_PROVIDER_SECRET    test-only provider credential (never commit it)
  MANAGER_CREDENTIAL_KEY Fernet key used by Manager provider credential storage

Optional provider environment:
  E2E_PROVIDER_REF       default: e2e-usage-provider; external seeded runs must use a published Operator provider ID
  E2E_PROVIDER_MODEL     default: aiteam-e2e-model
  E2E_PROVIDER_API_PROTOCOL  default: openai-completions

External seeded runs also validate the Manager → Operator runtime-config boundary and require
OPERATOR_URL/SERVICE_TOKEN to resolve the published provider access.

The tenant/member values are supplied by globalSetup.  Running the script directly
uses the same local PostgreSQL defaults as playwright.config.ts.

Output (stdout, JSON): tenant/account/employee/provider identifiers only.
"""

from __future__ import annotations

import json
import os
import sys
from urllib.parse import urlparse


_DEFAULT_ADMIN_DB_URL = "postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db"
_DEFAULT_DB_URL = "postgresql://app_rw:aiteam_dev@127.0.0.1:5433/manager_control_db"
_SUPPORTED_PROTOCOLS = {"openai-completions", "openai-responses", "anthropic-messages"}


def _provider_settings() -> tuple[str, str, str, str, str]:
    """Read E2E-only provider settings without ever echoing credential material."""
    endpoint = os.getenv("E2E_PROVIDER_ENDPOINT", "").strip()
    secret = os.getenv("E2E_PROVIDER_SECRET", "")
    credential_key = os.getenv("MANAGER_CREDENTIAL_KEY", "").strip()
    if not endpoint:
        raise RuntimeError("E2E_PROVIDER_ENDPOINT is required to seed an executable employee")
    parsed_endpoint = urlparse(endpoint)
    if parsed_endpoint.scheme not in {"http", "https"} or not parsed_endpoint.netloc:
        raise RuntimeError("E2E_PROVIDER_ENDPOINT must be an absolute http(s) URL")
    if not secret:
        raise RuntimeError(
            "E2E_PROVIDER_SECRET is required; provide a test-only provider secret via the environment"
        )
    if not credential_key:
        raise RuntimeError(
            "MANAGER_CREDENTIAL_KEY is required to encrypt the E2E provider credential"
        )

    provider_ref = os.getenv("E2E_PROVIDER_REF", "e2e-usage-provider").strip()
    model = os.getenv("E2E_PROVIDER_MODEL", "aiteam-e2e-model").strip()
    protocol = os.getenv("E2E_PROVIDER_API_PROTOCOL", "openai-completions").strip()
    if not provider_ref or not model:
        raise RuntimeError("E2E_PROVIDER_REF and E2E_PROVIDER_MODEL must be non-empty")
    if protocol not in _SUPPORTED_PROTOCOLS:
        raise RuntimeError(
            "E2E_PROVIDER_API_PROTOCOL must be openai-completions, openai-responses, or anthropic-messages"
        )
    return endpoint, secret, provider_ref, model, protocol


def main() -> int:
    admin_url = os.getenv("ADMIN_DB_URL", _DEFAULT_ADMIN_DB_URL).strip()
    biz_url = os.getenv("DB_URL", _DEFAULT_DB_URL).strip()
    if not admin_url or not biz_url:
        raise RuntimeError("ADMIN_DB_URL and DB_URL must be non-empty for a local E2E seed")
    endpoint, provider_secret, provider_ref, model, api_protocol = _provider_settings()

    slug = os.getenv("E2E_TENANT_SLUG", "e2e-smoke").strip()
    phone = os.getenv("E2E_MEMBER_ACCOUNT", "13800000001").strip()
    password = os.getenv("E2E_MEMBER_PASSWORD", "E2e-Pass-2024")
    employee_slug = os.getenv("E2E_AGENT_EMPLOYEE_SLUG", "e2e-usage-employee").strip()
    if not slug or not phone or not employee_slug:
        raise RuntimeError("E2E tenant/member/employee identifiers must be non-empty")

    # Resolve server/ from this file so standalone runs do not depend on cwd.
    server_root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "server")
    )
    if os.path.isdir(server_root) and server_root not in sys.path:
        sys.path.insert(0, os.path.abspath(server_root))

    import psycopg

    from shared.db import apply_migrations

    # 1. 先跑迁移（幂等），再注册/复用 E2E 租户（控制面，管理连接）。
    apply_migrations(admin_url, os.getenv("APP_RW_PASSWORD"))

    with psycopg.connect(admin_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT tenant_id FROM tenant_registry WHERE enterprise_slug = %s", (slug,)
        ).fetchone()
        if row:
            tenant_id = str(row[0])
        else:
            tenant_id = str(
                conn.execute(
                    "INSERT INTO tenant_registry (enterprise_slug) VALUES (%s) RETURNING tenant_id",
                    (slug,),
                ).fetchone()[0]
            )

    # 2. 落成员账号（must_reset=False，可直接登录）。
    from shared.contracts.enums import AuthProvider, EnterpriseRole
    from manager_service.auth_password_policy import validate_password_complexity
    from manager_service.employee_config_repository import EmployeeConfigRepository
    from manager_service.employee_config_service import EmployeeConfigService
    from manager_service.member_service import GrantService, MemberDeptService
    from manager_service.provider_credential_repository import ProviderCredentialRepository
    from manager_service.repository import TenantAuthRepository
    from manager_service.provider_credential_service import ProviderCredentialService
    from manager_service.operator_catalog import OperatorCatalogClient
    from manager_service.repository_member import GrantRepository, MemberDeptRepository
    from manager_service.schemas import EmployeeConfigIn, MemberGrantCreate
    from manager_service.schemas_provider import (
        ProviderCredentialCreate,
        ProviderCredentialUpdate,
        ProviderModelCapability,
    )
    from manager_service.security import hash_password
    from manager_service.snapshot_service import build_snapshot_service
    from shared.contracts.snapshot import ExecutionPolicy, ModelPolicy
    from shared.contracts.tenancy import TenantContext
    from shared.crypto import build_crypto_service
    from shared.db import PgTenantRouter

    router = PgTenantRouter(biz_url)
    external_seed = (
        os.getenv("E2E_EXTERNAL", "false").lower() == "true"
        and os.getenv("E2E_EXTERNAL_SEED", "false").lower() == "true"
    )
    operator = (
        OperatorCatalogClient(
            os.getenv("OPERATOR_URL", "http://127.0.0.1:8000"),
            service_identity="e2e-seed",
            service_token=os.getenv("SERVICE_TOKEN", "test-service-token"),
        )
        if external_seed
        else None
    )
    admin_ctx = TenantContext(
        tenant_id=tenant_id,
        user_id="e2e-seed",
        roles=[EnterpriseRole.ENTERPRISE_ADMIN.value],
    )
    existing = TenantAuthRepository(router).find_identity(
        admin_ctx, provider=AuthProvider.PHONE, external_id=phone
    )
    if existing is None:
        validate_password_complexity(password)
        member_id = TenantAuthRepository(router).create_user_with_identity(
            admin_ctx,
            provider=AuthProvider.PHONE,
            external_id=phone,
            secret=hash_password(password),
            roles=[EnterpriseRole.ENTERPRISE_ADMIN.value],
            display_name="e2e-smoke-member",
            must_reset=False,
        )
    else:
        member_id = existing.user_id
        # 幂等：重置为已知密码并清 must_reset，保证可登录；旧 seed 可能只有 member 角色。
        TenantAuthRepository(router).update_secret(
            admin_ctx,
            provider=AuthProvider.PHONE,
            external_id=phone,
            secret=hash_password(password),
            must_reset=False,
        )
        with router.session(admin_ctx) as session:
            session.execute(
                "UPDATE app_user SET roles = %s, status = 'active' WHERE id = %s",
                ([EnterpriseRole.ENTERPRISE_ADMIN.value], member_id),
            )

    member_ctx = TenantContext(
        tenant_id=tenant_id,
        user_id=member_id,
        roles=[EnterpriseRole.MEMBER.value],
    )

    # 3. Provider credential：明文只存在于本进程，ProviderCredentialService 加密后落库。
    crypto = build_crypto_service()
    provider_repo = ProviderCredentialRepository(router)
    provider_service = ProviderCredentialService(provider_repo, crypto)
    supported_models = [ProviderModelCapability(model=model, enabled=True)]
    provider = provider_repo.get_by_ref(admin_ctx, provider_ref=provider_ref)
    if provider is None:
        provider_service.create(
            admin_ctx,
            ProviderCredentialCreate(
                provider_ref=provider_ref,
                display_name="E2E usage provider",
                endpoint=endpoint,
                api_protocol=api_protocol,
                secret=provider_secret,
                visibility="tenant",
                supported_models=supported_models,
                model_catalog_source="manual",
            ),
        )
    else:
        provider_service.update(
            admin_ctx,
            ProviderCredentialUpdate(
                display_name="E2E usage provider",
                endpoint=endpoint,
                api_protocol=api_protocol,
                secret=provider_secret,
                visibility="tenant",
                supported_models=supported_models,
                model_catalog_source="manual",
            ),
            credential_id=provider.credential_id,
        )

    # 4. Employee 配置 + active 生命周期。
    employee_repo = EmployeeConfigRepository(router)
    platform_model = None
    platform_provider = None
    if operator is not None:
        catalog = operator.list_platform_catalog()
        platform_provider = next(
            (item for item in catalog.get("providers", []) if item.get("provider_id") == provider_ref),
            None,
        )
        for item in catalog.get("models", []):
            candidate = item.get("model") or {}
            if candidate.get("provider_id") == provider_ref and candidate.get("model_id") == model:
                platform_model = candidate
                break
        if platform_provider is None or platform_model is None:
            raise RuntimeError(f"platform model is unavailable: {provider_ref}/{model}")
    employee_service = EmployeeConfigService(employee_repo, operator)
    employee_body = EmployeeConfigIn(
        display_name="E2E Usage Employee",
        persona="You are an E2E usage employee. Respond briefly.",
        model_policy=ModelPolicy(
            model=model,
            provider_ref=provider_ref,
            provider_version=(int(platform_provider["version"]) if platform_provider else None),
            model_version=(int(platform_model["version"]) if platform_model else None),
        ),
        execution_policy=ExecutionPolicy(timeout_seconds=120),
    )
    employee = employee_repo.get_by_slug(admin_ctx, employee_slug=employee_slug)
    if employee is None:
        employee_out = employee_service.create(
            admin_ctx, employee_body, employee_slug=employee_slug
        )
    else:
        if employee.status == "archived":
            raise RuntimeError(
                "E2E_AGENT_EMPLOYEE_SLUG points to an archived employee; use a fresh tenant/slug"
            )
        employee_out = employee_service.update(
            admin_ctx, employee_body, employee_id=employee.employee_id
        )

    if employee_out.status == "draft":
        employee_out = employee_service.transition(
            admin_ctx, employee_id=employee_out.employee_id, transition="activate"
        )
    elif employee_out.status == "provisioning":
        employee_out = employee_service.transition(
            admin_ctx, employee_id=employee_out.employee_id, transition="activate"
        )
    elif employee_out.status == "provisioning_failed":
        employee_out = employee_service.transition(
            admin_ctx, employee_id=employee_out.employee_id, transition="retry_provision"
        )
        employee_out = employee_service.transition(
            admin_ctx, employee_id=employee_out.employee_id, transition="activate"
        )
    elif employee_out.status == "paused":
        employee_out = employee_service.transition(
            admin_ctx, employee_id=employee_out.employee_id, transition="resume"
        )
    if employee_out.status != "active":
        raise RuntimeError(
            f"E2E employee did not become active (status={employee_out.status})"
        )

    # 5. Member grant is the authorization source; generate a real member-scoped snapshot
    # through the same services used by the Manager route.  Snapshot is derived/read-only,
    # so it is intentionally not copied into Manager tables.
    member_repo = MemberDeptRepository(router)
    grant_service = GrantService(repo=GrantRepository(router), members=member_repo)
    grant_service.create_grant(
        admin_ctx,
        MemberGrantCreate(
            resource_type="expert",
            resource_id=employee_out.employee_id,
            member_ids=[member_id],
            department_ids=[],
        ),
    )
    snapshot_service = build_snapshot_service(
        config_service=employee_service,
        grant_service=grant_service,
        member_service=MemberDeptService(repo=member_repo),
        platform_catalog=operator,
    )
    snapshot = snapshot_service.generate(
        member_ctx,
        member_id=member_id,
        employee_id=employee_out.employee_id,
        employee_version=str(employee_out.version),
    )
    if snapshot.model_policy.model != model or snapshot.model_policy.provider_ref != provider_ref:
        raise RuntimeError("E2E employee snapshot does not match the seeded provider")

    # External seeded runs must also verify the real Manager → Operator runtime-config
    # boundary. Local fake-model runs intentionally skip this because their Operation
    # catalog has no relay credentials.
    if external_seed:
        try:
            runtime_service = ProviderCredentialService(
                provider_repo, crypto, snapshot_service, operator
            )
            runtime = runtime_service.runtime_config(member_ctx, employee_id=employee_out.employee_id)
        finally:
            operator.close()
        if (
            runtime.model != model
            or runtime.provider_ref != provider_ref
            or runtime.base_url != endpoint
        ):
            raise RuntimeError("E2E runtime provider config does not match the seeded snapshot")

    print(
        json.dumps(
            {
                "tenant_id": tenant_id,
                "account": phone,
                "employee_id": employee_out.employee_id,
                "provider_ref": provider_ref,
            }
        )
    )
    return 0


if __name__ == "__main__":
    # Keep failure output actionable but never print provider secret or decrypted config.
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - globalSetup needs a fail-fast prerequisite
        detail = str(exc)
        for name in ("E2E_PROVIDER_SECRET", "MANAGER_CREDENTIAL_KEY"):
            value = os.getenv(name)
            if value:
                detail = detail.replace(value, "[redacted]")
        print(f"seed-e2e-tenant failed: {type(exc).__name__}: {detail}", file=sys.stderr)
        raise SystemExit(1)
