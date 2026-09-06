"""Atomic Manager-owned solution publication using the existing tenant/RLS session."""
from contextlib import contextmanager
from dataclasses import dataclass

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Forbidden

from .capability_catalog_repository import CapabilityCatalogRepository
from .employee_config_repository import EmployeeConfigRepository
from .repository_member import GrantRepository, MemberDeptRepository
from .recruit_repository import RecruitRepository
from .recruit_order_repository import RecruitOrderRepository


@dataclass(frozen=True)
class RecruitWriteRepositories:
    employees: EmployeeConfigRepository
    grants: GrantRepository
    recruit: RecruitRepository
    orders: RecruitOrderRepository
    capability_catalog: CapabilityCatalogRepository | None = None
    members: MemberDeptRepository | None = None

    def __post_init__(self):
        # Keep compatibility fakes that snapshot repository __dict__ from
        # treating the optional seam as a repository when no bound catalog was
        # supplied.  Production transactions always populate it.
        if self.capability_catalog is None:
            self.__dict__.pop("capability_catalog", None)
        if self.members is None:
            self.__dict__.pop("members", None)


class _TransactionRouter:
    def __init__(self, session):
        self._session = session

    @contextmanager
    def session(self, ctx: TenantContext):
        if ctx.tenant_id != self._session.tenant_id:
            raise Forbidden("transaction tenant mismatch")
        yield self._session


class RecruitTransaction:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    @contextmanager
    def __call__(self, ctx: TenantContext):
        with self._router.session(ctx) as session:
            # Serialize solution publication within this enterprise, not external catalog IO.
            session.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ("recruit:" + ctx.tenant_id,))
            bound = _TransactionRouter(session)
            yield RecruitWriteRepositories(
                EmployeeConfigRepository(bound), GrantRepository(bound),
                RecruitRepository(bound), RecruitOrderRepository(bound),
                CapabilityCatalogRepository(bound), MemberDeptRepository(bound),
            )
