"""存量员工头像回填（一次性运维工具，不暴露北向 API）。

背景：员工头像存放在 ``employee_avatar`` 表，写入方只有三类——管理员上传、复制员工、
以及「招募 / 行业方案展开时按模板布种」。最后一项是本轮补齐的能力，因此**本轮之前**已经
存在的员工没有头像行：Manager 快照继续下发 ``avatar_url=None`` / ``avatar_version=0``，
企业端与桌面端都只能回退首字。

工具契约（与北向接口解耦，可重复执行）：

- 按 ``TenantContext`` 逐租户运行，``tenant_id`` 只从 ctx 读取，绝不跨租户查询；
- 只补缺失：已有头像行的员工一律跳过（幂等）；
- 只补有模板来源的员工（``source_template_id`` 非空），自定义员工保持现状；
- 只接受模板下发的栅格 data URL（复用 ``parse_catalog_avatar_url``）；旧模板的 HTTP /
  相对路径、无法解码的内容一律跳过并计数，绝不把外部 URL 写进企业库；
- 单个员工失败只计数与记日志（不含 URL、头像内容），不影响其它员工。

用法::

    python -m manager_service.avatar_backfill --dry-run
    python -m manager_service.avatar_backfill
    python -m manager_service.avatar_backfill --tenant <tenant_id> --public-base-url https://manager.example
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol, Sequence

from shared.config import load_settings, service_client_kwargs
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import NotFound

from .employee_avatar_repository import EmployeeAvatarRepository
from .employee_avatar_service import EmployeeAvatarService, parse_catalog_avatar_url
from .employee_config_repository import EmployeeConfigRepository, EmployeeConfigRow
from .knowledge_intake_service import ensure_storage_root, manager_storage_root
from .operator_catalog import OperatorCatalogClient

logger = logging.getLogger(__name__)

# 运维会话没有真实成员身份；数据访问只依赖 ctx.tenant_id（RLS），user_id 仅用于标识来源。
BACKFILL_ACTOR = "system:avatar-backfill"
DEFAULT_TENANT_LIMIT = 500


@dataclass
class AvatarBackfillReport:
    """一次回填的计数结果（dry-run 时 seeded 表示「将会写入」）。"""

    tenants: int = 0
    employees: int = 0
    seeded: int = 0
    skipped_existing: int = 0
    skipped_archived: int = 0
    skipped_no_template: int = 0
    skipped_avatar: int = 0
    template_unavailable: int = 0
    failed: int = 0
    # 被跳过的模板头像明细（有上限），运维据此定位需要回运营端改头像的模板。
    skipped_avatar_employees: list[dict[str, str]] = field(default_factory=list)

    def note_skipped_avatar(self, *, employee_id: str, template_id: str | None, reason: str) -> None:
        self.skipped_avatar += 1
        if len(self.skipped_avatar_employees) < MAX_SKIPPED_AVATAR_DETAILS:
            self.skipped_avatar_employees.append(
                {"employee_id": employee_id, "template_id": template_id or "", "reason": reason}
            )

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {name: getattr(self, name) for name in COUNTER_FIELDS}
        data["skipped_avatar_employees"] = list(self.skipped_avatar_employees)
        data["skipped_avatar_truncated"] = self.skipped_avatar > len(self.skipped_avatar_employees)
        return data


COUNTER_FIELDS = (
    "tenants",
    "employees",
    "seeded",
    "skipped_existing",
    "skipped_archived",
    "skipped_no_template",
    "skipped_avatar",
    "template_unavailable",
    "failed",
)

MAX_SKIPPED_AVATAR_DETAILS = 50


def avatar_skip_reason(value: str | None) -> str:
    """模板头像为什么写不了：给运维一个可执行的分类，而不是只说“跳过了”。"""
    text = (value or "").strip()
    if not text:
        return "empty"
    if text.startswith("//") or re.match(r"^[a-z][a-z0-9+.-]*://", text, re.IGNORECASE):
        return "external_url"
    if not text.startswith("data:"):
        return "relative_path"
    return "unsupported_format"


class _AvatarPort(Protocol):
    def exists(self, ctx: TenantContext, employee_id: str) -> bool: ...

    def update(self, ctx: TenantContext, *, employee_id: str, filename: str, mime_type: str, data: str) -> dict[str, Any]: ...


class _EmployeePort(Protocol):
    def list_all(self, ctx: TenantContext) -> list[EmployeeConfigRow]: ...


class _CatalogPort(Protocol):
    def pull_expert_template(self, *, template_id: str, version: str | None = None, tenant_id: str | None = None) -> Any: ...


def backfill_context(tenant_id: str) -> TenantContext:
    """构造运维用的租户上下文（tenant_id 是唯一的隔离边界）。"""
    return TenantContext(tenant_id=tenant_id, user_id=BACKFILL_ACTOR)


class EmployeeAvatarBackfill:
    """把模板头像补写到缺失员工头像行上。"""

    def __init__(
        self,
        *,
        employees: _EmployeePort,
        avatars: _AvatarPort,
        catalog: _CatalogPort,
    ) -> None:
        self._employees = employees
        self._avatars = avatars
        self._catalog = catalog

    def run(self, tenant_ids: Iterable[str], *, dry_run: bool = False) -> AvatarBackfillReport:
        report = AvatarBackfillReport()
        # 一个模板在本租户内只拉一次：方案展开时同一模板可能对应多个员工。
        templates: dict[tuple[str, str], Any] = {}
        for tenant_id in tenant_ids:
            ctx = backfill_context(tenant_id)
            report.tenants += 1
            for row in self._employees.list_all(ctx):
                self._process(ctx, row, report, templates, dry_run=dry_run)
        return report

    def _process(
        self,
        ctx: TenantContext,
        row: EmployeeConfigRow,
        report: AvatarBackfillReport,
        templates: dict[tuple[str, str], Any],
        *,
        dry_run: bool,
    ) -> None:
        report.employees += 1
        if row.status == "archived":
            report.skipped_archived += 1
            return
        if self._avatars.exists(ctx, row.employee_id):
            report.skipped_existing += 1
            return
        if not row.source_template_id:
            report.skipped_no_template += 1
            return
        template = self._template(ctx, row, report, templates)
        if template is None:
            return
        parsed = parse_catalog_avatar_url(getattr(template, "avatar_url", "") or "")
        if parsed is None:
            report.note_skipped_avatar(
                employee_id=row.employee_id,
                template_id=row.source_template_id,
                reason=avatar_skip_reason(getattr(template, "avatar_url", "")),
            )
            return
        mime_type, encoded = parsed
        if dry_run:
            report.seeded += 1
            return
        try:
            self._avatars.update(
                ctx,
                employee_id=row.employee_id,
                filename="template-avatar",
                mime_type=mime_type,
                data=encoded,
            )
        except NotFound:
            # 员工在扫描后消失（并发归档/删除）：不是工具故障，按失败计数即可。
            report.failed += 1
            logger.warning("avatar backfill skipped a vanished employee", extra={"tenant_id": ctx.tenant_id})
            return
        except Exception:  # noqa: BLE001 - 单个员工失败不影响其余员工
            report.failed += 1
            logger.warning("avatar backfill failed", extra={"tenant_id": ctx.tenant_id, "employee_id": row.employee_id})
            return
        report.seeded += 1

    def _template(
        self,
        ctx: TenantContext,
        row: EmployeeConfigRow,
        report: AvatarBackfillReport,
        templates: dict[tuple[str, str], Any],
    ) -> Any | None:
        key = (ctx.tenant_id, row.source_template_id or "")
        if key not in templates:
            try:
                templates[key] = self._catalog.pull_expert_template(
                    template_id=row.source_template_id or "",
                    version=row.source_template_version,
                    tenant_id=ctx.tenant_id,
                )
            except NotFound:
                # 模板已下架 / 不在本企业发布范围：这类员工保留现状，交管理员手工处理。
                templates[key] = None
            except Exception:  # noqa: BLE001 - Operator 不可达时缓存失败，避免逐员工重试
                templates[key] = None
                logger.warning("avatar backfill template pull failed", extra={"tenant_id": ctx.tenant_id})
        template = templates[key]
        if template is None:
            report.template_unavailable += 1
        return template


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
    public_base_url: str | None = None,
    catalog: _CatalogPort | None = None,
) -> tuple[EmployeeAvatarBackfill, Callable[[], list[str]]]:
    """按部署配置装配回填工具（CLI 与测试共用）。"""
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
        (public_base_url or "").rstrip("/") or None,
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
    parser = argparse.ArgumentParser(description="回填存量员工的模板头像（幂等，一次性运维工具）")
    parser.add_argument("--tenant", action="append", default=[], help="只处理指定 tenant_id（可重复）；缺省处理全部")
    parser.add_argument("--public-base-url", default="", help="写入 avatar_url 的对外基址；缺省写同源相对路径")
    parser.add_argument("--dry-run", action="store_true", help="只统计将要写入的数量，不落库")
    parser.add_argument("--tenant-limit", type=int, default=DEFAULT_TENANT_LIMIT, help="单次扫描的 tenant 上限")
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(level=logging.INFO)
    settings = load_settings("manager")
    if not settings.operator_url:
        raise RuntimeError("OPERATOR_URL is not configured; template avatars cannot be pulled")
    backfill, tenants = build_backfill(settings, public_base_url=args.public_base_url)
    tenant_ids = list(args.tenant) or tenants(args.tenant_limit)
    report = backfill.run(tenant_ids, dry_run=args.dry_run)
    print(json.dumps(report.as_dict(), ensure_ascii=False, sort_keys=True))
    return 0 if report.failed == 0 else 1


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
