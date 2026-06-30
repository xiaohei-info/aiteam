"""连接器操作编排（B05）。"""

from __future__ import annotations
import time

from shared.contracts.tenancy import TenantContext

from .connector_ops_repository import ConnectorOpsRepository


class ConnectorOpsService:
    def __init__(self, repo: ConnectorOpsRepository):
        self._repo = repo

    def get_status(self, ctx: TenantContext, connector_id: str) -> dict:
        row = self._repo.get_status(ctx, connector_id)
        if row is None:
            return {"connector_id": connector_id, "status": "disconnected",
                    "last_check_at": None, "error_message": None}
        return {
            "connector_id": row.connector_id, "status": row.status,
            "last_check_at": row.last_check_at, "error_message": row.error_message,
        }

    def test_connector(self, ctx: TenantContext, connector_id: str) -> dict:
        # 测试：local/mock 验证语义——记录为 success，真实连通性由用户端验证
        t0 = time.time()
        # 模拟轻量连接检查（Manager 不做真正对外调用——D18 凭据归 M5，执行在用户端）
        elapsed_ms = int((time.time() - t0) * 1000)
        success = True
        message = "连接基本检查通过（本地 mock，真实连通性由用户端验证）"

        # 记录测试结果
        self._repo.create_test(ctx, connector_id, success=success, latency_ms=elapsed_ms, message=message)
        # 更新状态
        self._repo.upsert_status(ctx, connector_id, status="connected" if success else "error",
                                 error_message=None if success else message)

        return {"connector_id": connector_id, "success": success, "latency_ms": elapsed_ms, "message": message}

    def get_grants(self, ctx: TenantContext, connector_id: str) -> dict:
        row = self._repo.get_grants(ctx, connector_id)
        if row is None:
            return {"connector_id": connector_id, "employee_ids": []}
        return {"connector_id": row.connector_id, "employee_ids": row.employee_ids}

    def set_grants(self, ctx: TenantContext, connector_id: str, employee_ids: list[str], action: str) -> dict:
        current = self._repo.get_grants(ctx, connector_id)
        if action == "revoke":
            if current:
                remaining = set(current.employee_ids) - set(employee_ids)
                employee_ids = list(remaining)
            else:
                employee_ids = []
        else:
            if current:
                merged = set(current.employee_ids) | set(employee_ids)
                employee_ids = list(merged)
        row = self._repo.set_grants(ctx, connector_id, employee_ids)
        return {"connector_id": row.connector_id, "employee_ids": row.employee_ids, "action": action, "updated": True}
