"""PG proof for atomic solution publication, audience union and concurrency."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import uuid

import pytest

from manager_service.auth_service import build_auth_service
from manager_service.operator_catalog import FakeOperatorCatalogClient
from manager_service.recruit_service import build_recruit_service
from manager_service.recruit_transaction import RecruitTransaction
from manager_service.repository_member import GrantRepository
from manager_service.schemas import ApplySolutionRequest, RecruitExpertRequest
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict
from .test_recruit_solution import _solution_package, _expert_template

pytestmark = pytest.mark.integration


@pytest.fixture
def recruitment(migrated_db, admin_url, two_tenants):
    tenant = two_tenants[0]
    auth = build_auth_service(migrated_db, admin_url)
    owner = auth.provision_owner(tenant, phone="owner-"+uuid.uuid4().hex, bootstrap_password="Fixture-Pass-1")
    a = auth.create_member(tenant, phone="a-"+uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    b = auth.create_member(tenant, phone="b-"+uuid.uuid4().hex, initial_password="Fixture-Pass-1")
    ctx = TenantContext(tenant_id=tenant, user_id=owner, roles=["owner"])
    router = PgTenantRouter(migrated_db)
    catalog = FakeOperatorCatalogClient()
    package = _solution_package()
    catalog.seed_solution(package)
    catalog.seed_expert(package.experts[0])
    svc = build_recruit_service(catalog=catalog, router=router)
    employee = svc.recruit_expert(ctx, RecruitExpertRequest(template_id=package.experts[0].template_id, member_ids=[a]))
    return svc, router, ctx, a, b, employee.employee_id


def state(router, ctx):
    with router.session(ctx) as s:
        assert s.execute("SELECT current_user").fetchone()[0] == "app_rw"
        return {table: s.execute(f"SELECT * FROM {table} ORDER BY id").fetchall() for table in (
            "employee", "member_grant", "solution_instance", "recruitment_order", "recruit_event", "solution_apply_record")}


@pytest.mark.parametrize("repository,method", [
    ("employees", "create"), ("employees", "transition_status"), ("orders", "claim_provisioning"), ("orders", "update"),
    ("grants", "extend"), ("grants", "upsert"), ("recruit", "create_solution_instance"),
    ("recruit", "append_recruit_event"), ("recruit", "create_solution_apply_record"),
])
def test_every_local_publication_failure_rolls_back_preexisting_audience(recruitment, repository, method):
    svc, router, ctx, a, b, employee = recruitment
    before = state(router, ctx)
    original = RecruitTransaction(router)
    @contextmanager
    def failing(ctx):
        with original(ctx) as repos:
            repo = getattr(repos, repository)
            operation = getattr(repo, method)
            def fail(*args, **kwargs):
                operation(*args, **kwargs)  # failure after a real SQL write, not before it
                raise RuntimeError("injected publication failure")
            setattr(repo, method, fail)
            yield repos
    svc._transaction = failing
    with pytest.raises(RuntimeError, match="injected publication failure"):
        svc.apply_solution(ctx, ApplySolutionRequest(solution_id="sol-1", member_ids=[b]))
    assert state(router, ctx) == before
    grant = GrantRepository(router).list_by_resource(ctx, resource_type="expert", resource_id=employee)[0]
    assert grant.member_ids == [a]


def test_recruit_failure_then_same_request_succeeds(recruitment, monkeypatch):
    svc, router, ctx, _, _, _ = recruitment
    svc._catalog.seed_expert(_expert_template(template_id="retry-template"))
    req = RecruitExpertRequest(template_id="retry-template", employee_slug="retry-expert")
    resolve = svc._catalog.resolve_tenant_access

    def unavailable(**kwargs):
        raise Conflict("provider temporarily unavailable")

    monkeypatch.setattr(svc._catalog, "resolve_tenant_access", unavailable)
    for _ in range(2):
        with pytest.raises(Conflict, match="provider temporarily unavailable"):
            svc.recruit_expert(ctx, req)
    failed = next(row for row in svc._orders.list_orders(ctx) if row.template_id == "retry-template")
    assert failed.status == "failed" and failed.error_code == "conflict"
    assert svc._employees.get_by_source_template(ctx, source_template_id="retry-template") is None

    monkeypatch.setattr(svc._catalog, "resolve_tenant_access", resolve)
    result = svc.recruit_expert(ctx, req)
    assert result.order.order_id == failed.id
    assert result.order.status == "succeeded"
    assert result.order.error_code is None and result.order.error_message is None
    with pytest.raises(Conflict, match="already recruited"):
        svc.recruit_expert(ctx, req)
    with router.session(ctx) as session:
        assert session.execute(
            "SELECT count(*) FROM employee WHERE source_template_id = %s", ("retry-template",),
        ).fetchone()[0] == 1


def test_solution_apply_rejects_cross_tenant_audience_before_publication(recruitment):
    svc, router, ctx, a, b, employee = recruitment
    before = state(router, ctx)
    with pytest.raises(Exception) as exc_info:
        svc.apply_solution(ctx, ApplySolutionRequest(solution_id="sol-1", member_ids=[str(uuid.uuid4())]))
    assert exc_info.value.status == 404
    assert state(router, ctx) == before
    grant = GrantRepository(router).list_by_resource(ctx, resource_type="expert", resource_id=employee)[0]
    assert grant.member_ids == [a]


def test_concurrent_solutions_preserve_reused_audience_and_duplicate_apply_conflicts(recruitment):
    svc, router, ctx, a, b, employee = recruitment
    package2 = _solution_package().model_copy(update={"solution_id": "sol-2"})
    svc._catalog.seed_solution(package2)
    def apply(solution):
        return svc.apply_solution(ctx, ApplySolutionRequest(solution_id=solution, member_ids=[b]))
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(apply, ["sol-1", "sol-2"]))
    assert all(employee in result.solution_instance.expert_employee_ids for result in results)
    grant = GrantRepository(router).list_by_resource(ctx, resource_type="expert", resource_id=employee)[0]
    assert set(grant.member_ids) == {a, b}
    before = state(router, ctx)
    with pytest.raises(Conflict):
        apply("sol-1")
    assert state(router, ctx) == before
    assert len(svc._employees.list_all(ctx)) == 2
