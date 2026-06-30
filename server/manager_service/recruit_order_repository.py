"""招募订单 RecruitmentOrder 租户作用域数据访问（AITEAM-243）。

追踪 Manager 端每个招募动作的异步执行链路：pending -> provisioning -> succeeded / failed /
cancelled。每个 order 粒度 = 单专家（对应一个 created_employee_id），保证可通过
idempotency_key 实现幂等招募。

铁律同 RecruitRepository：所有方法以 TenantContext 为隔离边界，tenant_id 只从 ctx 读，
SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离（04 section 6.1.1）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

# status 取值与迁移 0013 CHECK 约束严格对齐（禁止漂移）。
RECRUITMENT_ORDER_STATUSES = ("pending", "provisioning", "succeeded", "failed", "cancelled")
RECRUITMENT_ORDER_ACTIONS = ("recruit_expert", "apply_solution")


@dataclass(frozen=True)
class RecruitmentOrderRow:
    """招募订单行（单专家粒度，对应一个 created_employee_id）。"""

    id: str
    idempotency_key: str
    action: str
    template_id: str | None
    solution_id: str | None
    requested_by: str | None
    created_employee_id: str | None
    status: str
    error_code: str | None
    error_message: str | None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    # 状态机转换（对应旧 app/team_panel RecruitmentOrder 语义）
    def start_provisioning(self) -> "RecruitmentOrderRow":
        if self.status != "pending":
            raise ValueError(f"Cannot start provisioning from {self.status}")
        return self._replace(status="provisioning")

    def mark_succeeded(self, employee_id: str) -> "RecruitmentOrderRow":
        if self.status != "provisioning":
            raise ValueError(f"Cannot mark succeeded from {self.status}")
        return self._replace(status="succeeded", created_employee_id=employee_id)

    def mark_failed(self, error_code: str, error_message: str) -> "RecruitmentOrderRow":
        if self.status != "provisioning":
            raise ValueError(f"Cannot mark failed from {self.status}")
        return self._replace(status="failed", error_code=error_code, error_message=error_message)

    def cancel(self) -> "RecruitmentOrderRow":
        if self.status in ("succeeded", "cancelled"):
            raise ValueError(f"Cannot cancel from {self.status}")
        return self._replace(status="cancelled")

    def _replace(self, **kw: Any) -> "RecruitmentOrderRow":
        # dataclass frozen：构建新不可变行（纯状态机，不落库）。
        return RecruitmentOrderRow(
            id=kw.get("id", self.id),
            idempotency_key=kw.get("idempotency_key", self.idempotency_key),
            action=kw.get("action", self.action),
            template_id=kw.get("template_id", self.template_id),
            solution_id=kw.get("solution_id", self.solution_id),
            requested_by=kw.get("requested_by", self.requested_by),
            created_employee_id=kw.get("created_employee_id", self.created_employee_id),
            status=kw.get("status", self.status),
            error_code=kw.get("error_code", self.error_code),
            error_message=kw.get("error_message", self.error_message),
            created_at=kw.get("created_at", self.created_at),
            updated_at=kw.get("updated_at", self.updated_at),
        )


_ORDER_COLUMNS = (
    "id, idempotency_key, action, template_id, solution_id, requested_by, "
    "created_employee_id, status, error_code, error_message, created_at, updated_at"
)


def _row_to_order(row: Any) -> RecruitmentOrderRow:
    return RecruitmentOrderRow(
        id=str(row[0]),
        idempotency_key=row[1],
        action=row[2],
        template_id=row[3],
        solution_id=row[4],
        requested_by=str(row[5]) if row[5] is not None else None,
        created_employee_id=str(row[6]) if row[6] is not None else None,
        status=row[7],
        error_code=row[8],
        error_message=row[9],
        created_at=row[10],
        updated_at=row[11],
    )


class RecruitOrderRepository:
    """recruitment_order 的租户内读写。tenant_id 取自 ctx（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def create(
        self,
        ctx: TenantContext,
        *,
        idempotency_key: str,
        action: str,
        template_id: str | None = None,
        solution_id: str | None = None,
        requested_by: str | None = None,
        status: str = "pending",
    ) -> RecruitmentOrderRow:
        """本 tenant 建招募订单（初始 pending）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO recruitment_order "
                "(tenant_id, idempotency_key, action, template_id, solution_id, requested_by, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "RETURNING " + _ORDER_COLUMNS,
                (ctx.tenant_id, idempotency_key, action, template_id, solution_id, requested_by, status),
            ).fetchone()
        return _row_to_order(row)

    def get(self, ctx: TenantContext, *, order_id: str) -> RecruitmentOrderRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _ORDER_COLUMNS + " FROM recruitment_order WHERE id = %s", (order_id,)
            ).fetchone()
        return _row_to_order(row) if row is not None else None

    def get_by_idempotency_key(
        self, ctx: TenantContext, *, idempotency_key: str
    ) -> RecruitmentOrderRow | None:
        """按幂等键查本 tenant 内订单（幂等复取；跨 tenant RLS 不可见）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _ORDER_COLUMNS
                + " FROM recruitment_order WHERE idempotency_key = %s",
                (idempotency_key,),
            ).fetchone()
        return _row_to_order(row) if row is not None else None

    def list_orders(self, ctx: TenantContext) -> list[RecruitmentOrderRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _ORDER_COLUMNS + " FROM recruitment_order ORDER BY created_at"
            ).fetchall()
        return [_row_to_order(r) for r in rows]

    def update(self, ctx: TenantContext, order: RecruitmentOrderRow) -> RecruitmentOrderRow:
        """按当前 order 状态落库（更新 status + 结果字段；updated_at 由触发器刷新）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE recruitment_order SET status = %s, created_employee_id = %s, "
                "error_code = %s, error_message = %s WHERE id = %s RETURNING " + _ORDER_COLUMNS,
                (order.status, order.created_employee_id, order.error_code, order.error_message, order.id),
            ).fetchone()
        return _row_to_order(row)
