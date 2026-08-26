from __future__ import annotations

from unittest.mock import patch

from manager_service.rag import PgManagerRagService
from manager_service.rag_instances import RagInstance, RagInstanceRegistry
from shared.contracts.tenancy import TenantContext


class _Cursor:
    rowcount = 1

    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return []


class _Session:
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, query, params=()):
        if query.startswith("INSERT INTO rag_workspace"):
            return _Cursor((self.tenant_id, params[1], params[2], params[3]))
        return _Cursor((1,))


class _Router:
    def session(self, ctx):
        return _Session(ctx.tenant_id)


def test_fixed_manager_rag_routes_one_enterprise_workspace_per_deployment():
    registry = RagInstanceRegistry((RagInstance("rag", "http://rag", "secret", "enterprise-workspace"),))
    with patch("manager_service.rag.PgTenantRouter", return_value=_Router()):
        service = PgManagerRagService(
            "postgresql://unused",
            instance_registry=registry,
            enterprise_workspace="enterprise-workspace",
        )
        handle = service.get(
            TenantContext(tenant_id="tenant-a", user_id="member-a", roles=["owner"]),
            "enterprise_shared",
        )
        assert handle.workspace == "enterprise-workspace"
        assert handle.knowledge_space_id == "enterprise_shared"
        second = service.get(
            TenantContext(tenant_id="tenant-b", user_id="member-b", roles=["owner"]),
            "enterprise_shared",
        )
        assert second.workspace == handle.workspace
