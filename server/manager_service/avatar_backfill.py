"""存量员工头像补种（一次性运维工具，不暴露北向 API）。

背景：员工头像是 ``employee_avatar`` 表 + 固定路径文件 ``avatars/{tenant_id}/{employee_id}.webp``，
写入方只有三类——企业自建员工上传、员工复制、以及「招募 / 方案展开时按模板复制一次」。最后一项
是本轮补齐的能力，所以**本轮之前**已经存在的员工没有头像行：Manager 下发 ``avatar_url=None``，
企业端 / 用户端 / 桌面端都只能回退首字占位。本工具把当前模板头像补种给这些员工。

工具契约（可重复执行，与北向接口解耦）：

- 逐租户按 ``TenantContext`` 运行，``tenant_id`` 只来自 ctx（RLS 边界），绝不跨租户查询；
- **只补缺失**：已有头像行的员工一律跳过，不覆盖——管理员手工换过的头像不会被这个脚本盖掉；
- **只补有模板来源的员工**（``source_template_id`` 非空）：企业自建员工（``origin='custom'``）
  没有模板可复制，不在范围内；
- 头像字节走 Operator 的模板头像内容接口（与招募时同一条链路、同一份**当前**模板头像），
  不再解析目录里的内联 data URL——这是与旧版回填工具的主要差别，旧版基于 data URL + 随机
  文件名的存储方式，已随「一员工一文件」改造失效；
- 模板已下架 / 不在本企业发布范围 / 模板本身没有头像：计数跳过，不当失败；
- 单个员工失败只计数与 warning（日志不含头像内容），不影响其它员工；``failed > 0`` 退出码 1。

用法::

    python -m manager_service.avatar_backfill --dry-run
    python -m manager_service.avatar_backfill
    python -m manager_service.avatar_backfill --tenant <tenant_id>
"""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import dataclass, fields
from typing import Any, Callable, Iterable, Protocol, Sequence

from shared.config import load_settings, service_client_kwargs
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import NotFound

from .employee_avatar_repository import EmployeeAvatarRepository
from .employee_avatar_service import EmployeeAvatarService
from .employee_config_repository import EmployeeConfigRepository, EmployeeConfigRow
from .knowledge_intake_service import ensure_storage_root, manager_storage_root
from .operator_catalog import OperatorCatalogClient

logger = logging.getLogger(__name__)

# 运维会话没有真实成员身份；数据访问只依赖 ctx.tenant_id（RLS），user_id 仅用于标识来源。
BACKFILL_ACTOR = "system:avatar-backfill"
DEFAULT_TENANT_LIMIT = 500


@dataclass
class AvatarBackfillReport:
    """一次补种的计数结果（dry-run 时 ``seeded`` 表示「将会写入」）。"""

    tenants: int = 0
    employees: int = 0
    seeded: int = 0
    skipped_existing: int = 0
    skipped_archived: int = 0
    skipped_no_template: int = 0
    skipped_template_no_avatar: int = 0
    template_unavailable: int = 0
    failed: int = 0

    def as_dict(self) -> dict[str, int]:
        return {item.name: getattr(self, item.name) for item in fields(self)}


class _AvatarPort(Protocol):
    def avatar_urls(self, ctx: TenantContext) -> dict[str, str]: ...

    def seed_from_template(self, ctx: TenantContext, *, employee_id: str, data: bytes) -> Any: ...


class _EmployeePort(Protocol):
    def list_all(self, ctx: TenantContext) -> list[EmployeeConfigRow]: ...


class _CatalogPort(Protocol):
    def pull_expert_template_avatar(
        self, *, template_id: str, tenant_id: str
    ) -> tuple[bytes, int] | None: ...


def backfill_context(tenant_id: str) -> TenantContext:
    """构造运维用的租户上下文（tenant_id 是唯一的隔离边界）。"""
    return TenantContext(tenant_id=tenant_id, user_id=BACKFILL_ACTOR)


class EmployeeAvatarBackfill:
    """把当前模板头像补种给「有模板来源且还没有头像」的员工。"""

    def __init__(self, *, employees: _EmployeePort, avatars: _AvatarPort, catalog: _CatalogPort) -> None:
        self._employees = employees
        self._avatars = avatars
        self._catalog = catalog

    def run(self, tenant_ids: Iterable[str], *, dry_run: bool = False) -> AvatarBackfillReport:
        report = AvatarBackfillReport()
        # 同一模板在一个租户内只拉一次字节：方案展开时多个员工共用一个模板。
        cache: dict[tuple[str, str], tuple[str, bytes | None]] = {}
        for tenant_id in tenant_ids:
            ctx = backfill_context(tenant_id)
            report.tenants += 1
            # 一次查出本租户已有头像的员工，避免逐员工查库。
            existing = set(self._avatars.avatar_urls(ctx))
            for row in self._employees.list_all(ctx):
                self._process(ctx, row, report, existing, cache, dry_run=dry_run)
        return report

    def _process(
        self,
        ctx: TenantContext,
        row: EmployeeConfigRow,
        report: AvatarBackfillReport,
        existing: set[str],
        cache: dict[tuple[str, str], tuple[str, bytes | None]],
        *,
        dry_run: bool,
    ) -> None:
        report.employees += 1
        if row.status == "archived":
            report.skipped_archived += 1
            return
        if row.employee_id in existing:
            report.skipped_existing += 1
            return
        if not row.source_template_id:
            report.skipped_no_template += 1
            return
        state, data = self._avatar_bytes(ctx, row.source_template_id, cache)
        if state == "unavailable":
            report.template_unavailable += 1
            return
        if state == "empty" or data is None:
            report.skipped_template_no_avatar += 1
            return
        if dry_run:
            report.seeded += 1
            return
        try:
            self._avatars.seed_from_template(ctx, employee_id=row.employee_id, data=data)
        except Exception:  # noqa: BLE001 - 单个员工失败不影响其余员工
            report.failed += 1
            logger.warning(
                "avatar backfill failed",
                extra={"tenant_id": ctx.tenant_id, "employee_id": row.employee_id},
            )
            return
        # 同一模板的后续员工不再重复判断「已有头像」，但这一行已经有了。
        existing.add(row.employee_id)
        report.seeded += 1

    def _avatar_bytes(
        self,
        ctx: TenantContext,
        template_id: str,
        cache: dict[tuple[str, str], tuple[str, bytes | None]],
    ) -> tuple[str, bytes | None]:
        key = (ctx.tenant_id, template_id)
        if key not in cache:
            try:
                pulled = self._catalog.pull_expert_template_avatar(
                    template_id=template_id, tenant_id=ctx.tenant_id
                )
            except NotFound:
                # 模板已下架 / 不在本企业发布范围：这类员工保留现状，交管理员手工处理。
                cache[key] = ("unavailable", None)
            except Exception:  # noqa: BLE001 - Operator 不可达时缓存失败，避免逐员工重试
                cache[key] = ("unavailable", None)
                logger.warning(
                    "avatar backfill template avatar pull failed",
                    extra={"tenant_id": ctx.tenant_id, "template_id": template_id},
                )
            else:
                cache[key] = ("ok", pulled[0]) if pulled is not None else ("empty", None)
        return cache[key]


def list_tenants(admin_db_url: str, *, limit: int = DEFAULT_TENANT_LIMIT) -> list[str]:
    """列出控制库里登记过的 tenant（与用量上报相同的分页口径）。"""
    import psycopg

    with psycopg.connect(admin_db_url, autocommit=True) as connection:
        rows = connection.execute(
            "SELECT tenant_id::text FROM tenant_registry ORDER BY tenant_id LIMIT %s",
            (limit,),
        ).fetchall()
    return [str(row[0]) for row in rows if row and row[0]]


def build_backfill(
    settings,
    *,
    catalog: _CatalogPort | None = None,
) -> tuple[EmployeeAvatarBackfill, Callable[[int], list[str]]]:
    """按部署配置装配补种工具（CLI 与测试共用）。"""
    if not settings.db_url:
        raise RuntimeError("DB_URL is not configured; the avatar backfill needs the tenant database")
    router = PgTenantRouter(settings.db_url)
    peer_catalog = catalog or OperatorCatalogClient(
        base_url=settings.operator_url,
        client_kwargs=service_client_kwargs(settings),
    )
    avatars = EmployeeAvatarService(
        EmployeeAvatarRepository(router),
        ensure_storage_root(manager_storage_root(settings)),
    )
    backfill = EmployeeAvatarBackfill(
        employees=EmployeeConfigRepository(router),
        avatars=avatars,
        catalog=peer_catalog,
    )

    def tenants(limit: int = DEFAULT_TENANT_LIMIT) -> list[str]:
        if not settings.admin_db_url:
            raise RuntimeError("ADMIN_DB_URL is not configured; pass --tenant or configure the control database")
        return list_tenants(settings.admin_db_url, limit=limit)

    return backfill, tenants


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把当前模板头像补种给存量员工（幂等，不覆盖已有头像）"
    )
    parser.add_argument("--tenant", action="append", default=[], help="只处理指定 tenant_id（可重复）；缺省处理全部")
    parser.add_argument("--dry-run", action="store_true", help="只统计将要写入的数量，不落库")
    parser.add_argument("--tenant-limit", type=int, default=DEFAULT_TENANT_LIMIT, help="单次扫描的 tenant 上限")
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(level=logging.INFO)
    settings = load_settings("manager")
    if not settings.operator_url:
        raise RuntimeError("OPERATOR_URL is not configured; template avatars cannot be pulled")
    backfill, tenants = build_backfill(settings)
    tenant_ids = list(args.tenant) or tenants(args.tenant_limit)
    report = backfill.run(tenant_ids, dry_run=args.dry_run)
    print(json.dumps(report.as_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if report.failed == 0 else 1


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
