#!/usr/bin/env python3
"""AITEAM-224 E2E 租户/成员 seed（globalSetup 调用）。

为 Browser E2E 三端 smoke 准备一个确定的 E2E 租户 + 成员账号（must_reset=False，
可直接登录），供 manager / agent 端 smoke 登录使用。operation 端用系统账号，无需 seed。

幂等：重跑不报错（tenant 已存在则复用，member 已存在则重置密码为已知值）。
不清理：E2E 租户用固定 slug，跨 run 复用，避免每 run 漂移 tenant_id（登录需固定 tenant_id）。

环境变量（与 e2e/support/auth.ts defaultCredentials 对齐）：
  E2E_TENANT_SLUG (default e2e-smoke)
  E2E_MEMBER_ACCOUNT (default 13800000001)
  E2E_MEMBER_PASSWORD (default E2e-Pass-2024)
  ADMIN_DB_URL / DB_URL (manager 控制面/业务连接串)

输出（stdout，JSON）：{"tenant_id": "...", "account": "..."} 供 globalSetup 注入 env。
"""

from __future__ import annotations

import json
import os
import sys


def main() -> int:
    admin_url = os.getenv("ADMIN_DB_URL")
    biz_url = os.getenv("DB_URL")
    if not admin_url or not biz_url:
        print(json.dumps({"skipped": "ADMIN_DB_URL/DB_URL 未配置，跳过 manager/agent seed"}))
        return 0

    slug = os.getenv("E2E_TENANT_SLUG", "e2e-smoke")
    phone = os.getenv("E2E_MEMBER_ACCOUNT", "13800000001")
    password = os.getenv("E2E_MEMBER_PASSWORD", "E2e-Pass-2024")

    # server/ 是 v1 包根；本脚本由 globalSetup 在 web/ 下以 PYTHONPATH=../server 调用。
    server_root = os.path.join(os.getcwd(), "..", "server")
    if os.path.isdir(server_root) and server_root not in sys.path:
        sys.path.insert(0, os.path.abspath(server_root))

    import psycopg

    # 1. 先跑迁移（幂等），再注册/复用 E2E 租户（控制面，管理连接）。
    from shared.db import apply_migrations
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

    # 2. 落成员账号（must_reset=False，可直接登录）。已存在则重置密码 + 清 must_reset。
    from shared.contracts.enums import EnterpriseRole
    from manager_service.auth_password_policy import validate_password_complexity
    from shared.contracts.tenancy import TenantContext
    from manager_service.repository import TenantAuthRepository
    from shared.db import PgTenantRouter
    from manager_service.security import hash_password
    from shared.contracts.enums import AuthProvider

    router = PgTenantRouter(biz_url)
    repo = TenantAuthRepository(router)
    ctx = TenantContext(tenant_id=tenant_id, user_id="e2e-seed", roles=[EnterpriseRole.MEMBER.value])
    admin_roles = [EnterpriseRole.ENTERPRISE_ADMIN.value]
    existing = repo.find_identity(ctx, provider=AuthProvider.PHONE, external_id=phone)
    if existing is None:
        # 直接经 repository 落 enterprise_admin 角色：svc.create_member 硬编码 MEMBER，
        # 而 smoke / cross-tier 全链路需要写 provider 凭据 / 招募 / 授权（门控 owner/enterprise_admin）。
        validate_password_complexity(password)
        repo.create_user_with_identity(
            ctx, provider=AuthProvider.PHONE, external_id=phone,
            secret=hash_password(password), roles=admin_roles,
            display_name="e2e-smoke-member", must_reset=False,
        )
    else:
        # 幂等：重置为已知密码并清 must_reset，保证可登录。
        repo.update_secret(
            ctx, provider=AuthProvider.PHONE, external_id=phone,
            secret=hash_password(password), must_reset=False,
        )
        # 兼容旧 seed 仅落 MEMBER 的历史数据：补齐 enterprise_admin，
        # 避免跨端 E2E 写 provider/招募/授权时被 403 拒绝。
        with router.session(ctx) as s:
            s.execute(
                "UPDATE app_user SET roles = %s WHERE id = %s",
                (admin_roles, existing.user_id),
            )

    print(json.dumps({"tenant_id": tenant_id, "account": phone}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
