"""招募专家 / 应用方案业务编排与红线验收（M6，05 F06/F07 / 04 §6.1，D12/D16/D22）。

非 integration（默认门必跑，不依赖 PG）：
- F06 招募专家：拉模板(mock) → 建 employee 实例 → 可选授权 → 审计（用内存伪 repository 验）。
- F07 应用方案：拉方案包(mock) → 建 solution_instance → 展开专家 + 知识/技能 → 默认授权 → 审计。
- 红线断言：
  1. Operator 不写 Manager 库（catalog 端口只读拉取；本卡 mock，无反向写）。
  2. Manager 不改模板真相（拉下来的 ExpertTemplateDetail 不可变；落本地副本）。
  3. 跨租户隔离（D22）：t-a 建的 employee/方案实例，t-b 看不到/查不到。
  4. 角色门：member 不能招募/应用方案（403）。
  5. 冲突：同 tenant 同 slug 重复招募 → 409；同 tenant 同 (solution_id,version) 重复应用 → 409。
"""

from __future__ import annotations

import uuid

import pytest

from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound

from manager_service.employee_config_repository import EmployeeConfigRow
from manager_service.operator_catalog import (
    FakeOperatorCatalogClient,
    OperatorCatalogPort,
)
from manager_service.provider_credential_repository import ProviderCredentialRow
from manager_service.recruit_order_repository import RecruitmentOrderRow, RecruitOrderRepository
from manager_service.recruit_repository import (
    RecruitEventRow,
    SolutionApplyRecordRow,
    SolutionInstanceRow,
)
from manager_service.recruit_service import RecruitService
from manager_service.repository_member import GrantRow
from manager_service.schemas import (
    ApplySolutionRequest,
    RecruitExpertRequest,
)


# ---- 内存伪 repository（模拟 RLS 跨租户不可见；tenant_id 只从 ctx 读，D22）----


class _FakeEmployeeRepo:
    """内存伪 employee repository（同 EmployeeConfigRepository 接口形状）。"""

    def __init__(self):
        self._store: dict[str, dict[str, EmployeeConfigRow]] = {}

    def _bucket(self, ctx: TenantContext) -> dict[str, EmployeeConfigRow]:
        return self._store.setdefault(ctx.tenant_id, {})

    def create(self, ctx, **kw):
        row = EmployeeConfigRow(
            employee_id=str(uuid.uuid4()), employee_slug=kw["employee_slug"],
            display_name=kw["display_name"], persona=kw["persona"], model=kw["model"],
            provider_ref=kw["provider_ref"], thinking_level=kw["thinking_level"],
            runtime_binding=kw["runtime_binding"], timeout_seconds=kw["timeout_seconds"],
            tools=kw["tools"], skills=kw["skills"], knowledge_refs=kw["knowledge_refs"],
            connector_refs=kw["connector_refs"], memory_policy=kw["memory_policy"], version=1,
            status=kw.get("status", "applied"),
        )
        self._bucket(ctx)[row.employee_id] = row
        return row

    def get(self, ctx, *, employee_id):
        return self._bucket(ctx).get(employee_id)

    def get_by_slug(self, ctx, *, employee_slug):
        for r in self._bucket(ctx).values():
            if r.employee_slug == employee_slug:
                return r
        return None


class _FakeGrantRepo:
    """内存伪 GrantRepository（模拟 D12 授权 upsert；跨租户分桶）。"""

    def __init__(self):
        self._store: dict[str, dict[tuple[str, str], GrantRow]] = {}

    def _bucket(self, ctx: TenantContext) -> dict[tuple[str, str], GrantRow]:
        return self._store.setdefault(ctx.tenant_id, {})

    def upsert(self, ctx, *, resource_type, resource_id, department_ids, member_ids):
        key = (resource_type, resource_id)
        row = GrantRow(
            id=str(uuid.uuid4()), resource_type=resource_type, resource_id=resource_id,
            department_ids=list(department_ids), member_ids=list(member_ids), updated_at=None,
        )
        self._bucket(ctx)[key] = row
        return row


class _FakeProviderRepo:
    """内存伪 ProviderCredentialRepository（仅实现 resolver 需要的查询能力，避免重复写逻辑）。"""

    def __init__(self):
        self._by_ref: dict[str, ProviderCredentialRow] = {}
        self._all: list[ProviderCredentialRow] = []

    def seed(
        self,
        provider_ref: str,
        supported_models: list[dict] | None = None,
    ) -> ProviderCredentialRow:
        row = ProviderCredentialRow(
            credential_id=str(uuid.uuid4()),
            provider_ref=provider_ref,
            display_name=provider_ref,
            mode="relay",
            endpoint=None,
            encrypted_secret=b"",
            visibility="tenant",
            allowed_member_ids=[],
            supported_models=list(supported_models or []),
            model_catalog_source="manual",
            version=1,
        )
        self._by_ref[provider_ref] = row
        self._all.append(row)
        return row

    def get_by_ref(self, ctx, *, provider_ref: str) -> ProviderCredentialRow | None:
        return self._by_ref.get(provider_ref)

    def list_providers_supporting_model(self, ctx, *, model: str) -> list[ProviderCredentialRow]:
        out: list[ProviderCredentialRow] = []
        for row in self._all:
            for cap in row.supported_models:
                if cap.get("model") == model and cap.get("enabled", True):
                    out.append(row)
                    break
        return out


class _FakeRecruitRepo:
    """内存伪 RecruitRepository（solution_instance + recruit_event，跨租户分桶）。"""

    def __init__(self):
        self._solutions: dict[str, dict[str, SolutionInstanceRow]] = {}
        self._events: dict[str, list[RecruitEventRow]] = {}
        # AITEAM-242 — 方案应用记录
        self._apply_records: dict[str, dict[str, SolutionApplyRecordRow]] = {}
        self._apply_seq: int = 0

    def create_solution_instance(self, ctx, **kw):
        row = SolutionInstanceRow(
            id=str(uuid.uuid4()), solution_id=kw["solution_id"],
            solution_version=kw["solution_version"], display_name=kw["display_name"],
            status=kw.get("status", "applied"),
            expert_employee_ids=list(kw["expert_employee_ids"]),
            knowledge_refs=list(kw["knowledge_refs"]), skill_refs=list(kw["skill_refs"]),
            planner_prompt=kw.get("planner_prompt", ""),
            subtask_prompt=kw.get("subtask_prompt", ""),
            aggregate_prompt=kw.get("aggregate_prompt", ""),
            default_grants_meta=kw.get("default_grants_meta"), template_meta=kw.get("template_meta"),
        )
        self._solutions.setdefault(ctx.tenant_id, {})[row.id] = row
        return row

    def get_solution_instance(self, ctx, *, instance_id):
        return self._solutions.get(ctx.tenant_id, {}).get(instance_id)

    def find_solution_instance(self, ctx, *, solution_id, solution_version):
        for r in self._solutions.get(ctx.tenant_id, {}).values():
            if r.solution_id == solution_id and r.solution_version == solution_version:
                return r
        return None

    def list_solution_instances(self, ctx):
        return list(self._solutions.get(ctx.tenant_id, {}).values())

    def append_recruit_event(self, ctx, **kw):
        row = RecruitEventRow(
            id=str(uuid.uuid4()), action=kw["action"],
            actor_user_id=kw.get("actor_user_id"),
            source_template_id=kw.get("source_template_id"),
            source_template_version=kw.get("source_template_version"),
            source_solution_id=kw.get("source_solution_id"),
            source_solution_version=kw.get("source_solution_version"),
            target_employee_ids=list(kw.get("target_employee_ids") or []),
            target_solution_instance_id=kw.get("target_solution_instance_id"),
            detail=kw.get("detail"), created_at=None,
        )
        self._events.setdefault(ctx.tenant_id, []).append(row)
        return row

    def list_recruit_events(self, ctx):
        return list(self._events.get(ctx.tenant_id, []))

    # ---- 方案应用记录伪实现（AITEAM-242）----
    def create_solution_apply_record(self, ctx, **kw):
        import uuid as _uuid
        record_id = str(_uuid.uuid4())
        row = SolutionApplyRecordRow(
            id=record_id,
            tenant_id=ctx.tenant_id,
            solution_id=kw["solution_id"],
            solution_version=kw["solution_version"],
            applied_by=kw.get("applied_by"),
            status=kw.get("status", "applied"),
            expert_instance_ids=list(kw.get("expert_instance_ids") or []),
            detail=kw.get("detail"),
            created_at=self._apply_seq,
            updated_at=self._apply_seq,
        )
        self._apply_seq += 1
        # Enforce unique (tenant, solution, solution_version) by overwriting the previous row.
        bucket = self._apply_records.setdefault(ctx.tenant_id, {})
        existing = next(
            (k for k, v in bucket.items()
             if v.solution_id == kw["solution_id"] and v.solution_version == kw["solution_version"]),
            None,
        )
        if existing is not None:
            record_id = existing
        bucket[record_id] = row
        return row

    def list_solution_apply_records(self, ctx, *, solution_id=None, status=None):
        rows = list(self._apply_records.get(ctx.tenant_id, {}).values())
        if solution_id:
            rows = [r for r in rows if r.solution_id == solution_id]
        if status:
            rows = [r for r in rows if r.status == status]
        rows.sort(key=lambda r: (r.created_at is None, r.created_at or 0), reverse=True)
        return rows

    def get_latest_solution_apply_record(self, ctx, *, solution_id):
        rows = [r for r in self._apply_records.get(ctx.tenant_id, {}).values()
                if r.solution_id == solution_id and r.status == "applied"]
        if not rows:
            return None
        # 对齐真实 repo 的 ORDER BY created_at DESC——fake 的 created_at 是单调 seq；
        # 按随机 UUID id 排序是非确定性的（CI 曾因此掷骰子失败）。
        rows.sort(key=lambda r: r.created_at, reverse=True)
        return rows[0]


class _FakeOrderRepo(RecruitOrderRepository):
    """fake orders repo"""

    def __init__(self):
        self._store = {}

    def _bucket(self, ctx):
        return self._store.setdefault(ctx.tenant_id, {})

    def create(self, ctx, **kw):
        row = RecruitmentOrderRow(
            id=str(uuid.uuid4()), idempotency_key=kw["idempotency_key"],
            action=kw.get("action", "recruit_expert"),
            template_id=kw.get("template_id"), solution_id=kw.get("solution_id"),
            requested_by=kw.get("requested_by"), created_employee_id=None,
            status=kw.get("status", "pending"), error_code=None, error_message=None,
        )
        self._bucket(ctx)[row.id] = row
        return row

    def get(self, ctx, *, order_id):
        return self._bucket(ctx).get(order_id)

    def get_by_idempotency_key(self, ctx, *, idempotency_key):
        for r in self._bucket(ctx).values():
            if r.idempotency_key == idempotency_key:
                return r
        return None

    def list_orders(self, ctx):
        return sorted(self._bucket(ctx).values(), key=lambda r: (r.created_at is None, r.created_at, r.id))

    def update(self, ctx, order):
        self._bucket(ctx)[order.id] = order
        return order


def _build_service(catalog: OperatorCatalogPort):
    emp = _FakeEmployeeRepo()
    grant = _FakeGrantRepo()
    recruit = _FakeRecruitRepo()
    orders = _FakeOrderRepo()
    providers = _FakeProviderRepo()
    # 默认 seed 一个与 _expert_template 中 explicit provider_ref="relay-default" 匹配的 provider，
    # 保证既有测试走 explicit 路径通过（AITEAM-682 不改变 explicit 语义）。
    providers.seed("relay-default", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = RecruitService(
        catalog=catalog, employees=emp, grants=grant, recruit=recruit, orders=orders, providers=providers,
    )
    return svc, emp, grant, recruit, orders


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u-1", roles=roles or ["owner"])


def _expert_template(template_id="tpl-1", version="v1", display_name="专家A") -> ExpertTemplateDetail:
    return ExpertTemplateDetail(
        template_id=template_id, version=version, display_name=display_name,
        persona="你是测试专家",
        recommended_config={
            "model": "claude-opus-4-8", "provider_ref": "relay-default",
            "thinking_level": "high", "runtime_binding": "hermes_acp",
            "timeout_seconds": 120, "tools": ["search"], "skills": ["code-review"],
            "knowledge_refs": ["ks_default"],
        },
    )


# ---- F06 招募专家 ----


def test_recruit_expert_creates_employee_instance_from_template():
    """F06 主路径：拉模板 → 建 employee 实例（persona/model 等中立字段来自模板，D16）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, emp, _, recruit, _ = _build_service(catalog)

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"),
    )

    assert result.employee_slug == "exp-a"
    assert result.source_template_id == "tpl-1"
    assert result.source_template_version == "v1"
    # employee 实例落地：中立字段来自模板 recommended_config
    row = emp.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.display_name == "专家A"
    assert row.model == "claude-opus-4-8"
    assert row.runtime_binding == "hermes_acp"
    assert row.skills == ["code-review"]
    assert result.grants_applied is False
    # 审计事件已记
    events = recruit.list_recruit_events(_ctx("t-a"))
    assert len(events) == 1
    assert events[0].action == "recruit_expert"
    assert events[0].source_template_id == "tpl-1"
    assert result.employee_id in events[0].target_employee_ids


def test_recruit_expert_binds_grants_when_subjects_provided():
    """F06 可选招募即绑定授权（D12）：提供 department_ids/member_ids → 落 member_grant。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, _, grant, _, _ = _build_service(catalog)

    result = svc.recruit_expert(
        _ctx("t-a"),
        RecruitExpertRequest(
            template_id="tpl-1", employee_slug="exp-a",
            department_ids=["dept-1"], member_ids=["mem-1"],
        ),
    )

    assert result.grants_applied is True
    grants = grant._bucket(_ctx("t-a"))
    assert ("expert", result.employee_id) in grants
    row = grants[("expert", result.employee_id)]
    assert row.department_ids == ["dept-1"]
    assert row.member_ids == ["mem-1"]


def test_recruit_expert_overrides_take_precedence():
    """F06 display_name_override / persona_override 覆盖模板默认值。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, emp, _, _, _ = _build_service(catalog)

    result = svc.recruit_expert(
        _ctx("t-a"),
        RecruitExpertRequest(
            template_id="tpl-1", employee_slug="exp-a",
            display_name_override="自定义名", persona_override="自定义 persona",
        ),
    )
    row = emp.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.display_name == "自定义名"
    assert row.persona == "自定义 persona"


def test_recruit_expert_slug_conflict_in_tenant():
    """同 tenant 同 slug 重复招募 → 409 Conflict。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, _, _, _, _ = _build_service(catalog)

    svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="dup"))
    with pytest.raises(Conflict):
        svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="dup"))


def test_recruit_expert_member_forbidden():
    """招募写操作需 owner/enterprise_admin；member → 403（03 §9.7）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, _, _, _, _ = _build_service(catalog)

    with pytest.raises(Forbidden):
        svc.recruit_expert(
            _ctx("t-a", roles=["member"]),
            RecruitExpertRequest(template_id="tpl-1", employee_slug="x"),
        )


# ---- F07 应用方案 ----


def _solution_package(solution_id="sol-1", version="v1") -> SolutionPackage:
    return SolutionPackage(
        solution_id=solution_id, version=version, display_name="行业方案A",
        experts=[
            ExpertTemplateDetail(
                template_id="tpl-a", version="v1", display_name="专家甲",
                persona="你是甲", recommended_config={"model": "m-a", "skills": ["s-a"]},
            ),
            ExpertTemplateDetail(
                template_id="tpl-b", version="v1", display_name="专家乙",
                persona="你是乙", recommended_config={"model": "m-b", "knowledge_refs": ["ks-b"]},
            ),
        ],
        knowledge_refs=["ks-shared"],
        skill_refs=["skill-shared"],
        default_grants={"department_ids": ["dept-default"]},
    )


def test_apply_solution_expands_experts_and_instance():
    """F07 主路径：拉方案包 → 建 solution_instance → 展开两个专家 employee 实例 + 知识/技能叠加。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, emp, _, recruit, _ = _build_service(catalog)

    result = svc.apply_solution(
        _ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"),
    )

    inst = result.solution_instance
    assert inst.solution_id == "sol-1"
    assert inst.solution_version == "v1"
    assert inst.display_name == "行业方案A"
    assert len(inst.expert_employee_ids) == 2
    assert len(result.experts) == 2
    # 知识/技能引用落到方案实例 + 叠加到每个专家
    assert inst.knowledge_refs == ["ks-shared"]
    assert inst.skill_refs == ["skill-shared"]
    for eid in inst.expert_employee_ids:
        row = emp.get(_ctx("t-a"), employee_id=eid)
        assert "ks-shared" in row.knowledge_refs
        assert "skill-shared" in row.skills
    # 审计
    events = recruit.list_recruit_events(_ctx("t-a"))
    assert len(events) == 1
    assert events[0].action == "apply_solution"
    assert events[0].source_solution_id == "sol-1"


def test_apply_solution_applies_default_grants_from_package():
    """F07：请求未指定授权时，用方案包 default_grants 展开到每个专家（D12）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, grant, _, _ = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))

    assert result.grants_applied is True
    grants = grant._bucket(_ctx("t-a"))
    for eid in result.solution_instance.expert_employee_ids:
        assert ("expert", eid) in grants
        assert grants[("expert", eid)].department_ids == ["dept-default"]


def test_apply_solution_request_grants_override_package_defaults():
    """F07：请求显式指定授权 → 覆盖方案包 default_grants。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, grant, _, _ = _build_service(catalog)

    result = svc.apply_solution(
        _ctx("t-a"),
        ApplySolutionRequest(solution_id="sol-1", department_ids=["dept-req"], member_ids=["mem-req"]),
    )
    assert result.grants_applied is True
    grants = grant._bucket(_ctx("t-a"))
    for eid in result.solution_instance.expert_employee_ids:
        assert grants[("expert", eid)].department_ids == ["dept-req"]
        assert grants[("expert", eid)].member_ids == ["mem-req"]


def test_apply_solution_conflict_when_already_applied():
    """同 tenant 同 (solution_id, version) 重复应用方案 → 409（避免重复展开）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, _, _ = _build_service(catalog)

    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))
    with pytest.raises(Conflict):
        svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))


def test_apply_solution_member_forbidden():
    """应用方案写操作需 owner/enterprise_admin；member → 403。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, _, _ = _build_service(catalog)

    with pytest.raises(Forbidden):
        svc.apply_solution(
            _ctx("t-a", roles=["member"]), ApplySolutionRequest(solution_id="sol-1"),
        )


def test_get_solution_instance_not_found_cross_tenant():
    """跨租户查方案实例：t-a 建的，t-b 视角 → 404（D22 + RLS 语义）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, _, _ = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))
    with pytest.raises(NotFound):
        svc.get_solution_instance(_ctx("t-b"), instance_id=result.solution_instance.id)


# ---- 红线：Operator 只读拉取 + Manager 不改模板真相 ----


def test_operator_catalog_is_read_only_port():
    """红线①：Operator 端口只读（pull 详情 + list 浏览），无反向写方法（05 §5 通信面方向铁律）。"""
    # OperatorCatalogPort 抽象只有只读 pull_*/list_* 方法，无 seed/write/push 等反向接口。
    methods = {m for m in dir(OperatorCatalogPort) if not m.startswith("_")}
    assert methods == {
        "pull_expert_template",
        "pull_solution_package",
        "list_expert_templates",
        "list_solution_packages",
    }, methods
    # 红线兜底：端口不得出现任何反向写语义方法名。
    write_like = {"seed", "write", "push", "create", "update", "delete", "put", "post"}
    assert not any(any(w in m for w in write_like) for m in methods), methods


def test_recruit_does_not_mutate_pulled_template():
    """红线②：Manager 拉下来的模板不可变；落本地 employee 用副本，不改模板真相。"""
    catalog = FakeOperatorCatalogClient()
    template = _expert_template()
    catalog.seed_expert(template)
    svc, _, _, _, _ = _build_service(catalog)

    # 用模板 Persona 字段做"被改"探针：招募后模板 persona 应保持不变
    original_persona = template.persona
    svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"))

    # 再拉一次，确认 Operator 侧真相未被改（Fake 返回 deep copy 副本，本断言验证不变性契约）
    pulled_again = catalog.pull_expert_template(template_id="tpl-1")
    assert pulled_again.persona == original_persona
    # 原对象引用也不变（不可变契约）
    assert template.persona == original_persona


def test_cross_tenant_employee_isolation():
    """红线③：t-a 招募的专家，t-b 的 employee repository 视角看不到（D22 + RLS）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, emp, _, _, _ = _build_service(catalog)

    created = svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"))
    # t-b 看不到（不同 tenant 桶）
    assert emp.get(_ctx("t-b"), employee_id=created.employee_id) is None
    # t-b 同 slug 不冲突（不同 tenant）
    created_b = svc.recruit_expert(_ctx("t-b"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"))
    assert created_b.employee_id != created.employee_id


def test_cross_tenant_solution_instances_isolated():
    """红线③：t-a 应用的方案实例，t-b list/get 看不到（D22 + RLS）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, _, _ = _build_service(catalog)

    svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))

    # t-b list 为空
    assert svc.list_solution_instances(_ctx("t-b")) == []
    # t-b 同 (solution_id, version) 不冲突（不同 tenant）
    result_b = svc.apply_solution(_ctx("t-b"), ApplySolutionRequest(solution_id="sol-1"))
    assert result_b.solution_instance.solution_id == "sol-1"


# 注：原 test_operator_catalog_real_client_not_implemented_until_wired 已删除——
# OperatorCatalogClient 自 #176/#213 起为真实 HTTP 客户端（不再抛 NotImplementedError）；
# 真实客户端覆盖见 tests/manager/test_operator_catalog_client.py（mock transport）。


# ---- FakeOperatorCatalogClient 行为（mock 契约：版本/缺失/只读）----


def test_fake_catalog_versioned_and_latest_lookup():
    """Fake 支持指定版本拉取与取最新；缺失模板 → 404 NotFound。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template(version="v1"))
    catalog.seed_expert(_expert_template(version="v2", display_name="v2名"))

    assert catalog.pull_expert_template(template_id="tpl-1").display_name == "v2名"  # latest
    assert catalog.pull_expert_template(template_id="tpl-1", version="v1").version == "v1"
    with pytest.raises(NotFound):
        catalog.pull_expert_template(template_id="missing")
    with pytest.raises(NotFound):
        catalog.pull_solution_package(solution_id="missing")


# ---- AITEAM-243: 招募订单追踪验收 ----


def test_recruit_expert_returns_completed_order():
    """F06 招募成功后，result.order 应携带 succeeded 状态 + created_employee_id。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, _, _, _, orders = _build_service(catalog)

    result = svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"))

    assert result.order is not None
    assert result.order.status == "succeeded"
    assert result.order.created_employee_id == result.employee_id
    assert result.order.action == "recruit_expert"
    # order stored in repo
    stored = orders.list_orders(_ctx("t-a"))
    assert len(stored) == 1
    assert stored[0].status == "succeeded"


def test_recruit_expert_failure_marks_order_failed():
    """F06 招募抛异常时，order 应 failed 并被持久化。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, emp, _, _, orders = _build_service(catalog)

    # 让 employee 落库 create 失败（模拟 provisioning 阶段报错）
    original_create = emp.create
    def boom(ctx, **kw):
        from shared.errors import NotFound as _NotFound
        raise _NotFound("database unavailable")
    emp.create = boom

    from shared.errors import NotFound
    with pytest.raises(NotFound):
        svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="boom"))

    stored = orders.list_orders(_ctx("t-a"))
    assert len(stored) == 1
    assert stored[0].status == "failed"
    assert stored[0].error_code == "template_not_found"
    # restore (not strictly needed)
    emp.create = original_create



def test_apply_solution_expands_one_order_per_expert():
    """F07 方案展开每个专家都生成一个 succeeded order。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_solution_package())
    svc, _, _, _, orders = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-1"))
    assert len(result.experts) == 2
    # 每个 expert 结果都带 order
    for r in result.experts:
        assert r.order is not None
        assert r.order.status == "succeeded"
        assert r.order.action == "apply_solution"
        assert r.order.solution_id == "sol-1"

    stored = orders.list_orders(_ctx("t-a"))
    assert len(stored) == 2
    assert all(o.status == "succeeded" for o in stored)


def test_list_and_get_recruit_orders():
    """查询接口 list/get 返回 RecruitmentOrderOut 形态（按 tenant 裁剪）。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())
    svc, _, _, _, _ = _build_service(catalog)
    svc.recruit_expert(_ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"))

    orders_out = svc.list_recruit_orders(_ctx("t-a"))
    assert len(orders_out) == 1
    o = orders_out[0]
    assert o.status == "succeeded"
    assert o.order_id
    # get one
    got = svc.get_recruit_order(_ctx("t-a"), order_id=o.order_id)
    assert got.order_id == o.order_id
    # t-b is empty (RLS)
    assert svc.list_recruit_orders(_ctx("t-b")) == []
    from shared.errors import NotFound
    with pytest.raises(NotFound):
        svc.get_recruit_order(_ctx("t-b"), order_id=o.order_id)
# ---- Issue #285：方案内专家绑定排序号（sequence_no）与启用开关（enabled）----

def _ordered_solution_package() -> SolutionPackage:
    """tpl-z 排序号=5（最后展开），tpl-a 排序号=2，tpl-disabled 已禁用。"""
    return SolutionPackage(
        solution_id="sol-ord", version="v1", display_name="Ordered",
        experts=[
            ExpertTemplateDetail(
                template_id="tpl-z", version="v1", display_name="专家Z",
                sequence_no=5, enabled=True,
            ),
            ExpertTemplateDetail(
                template_id="tpl-a", version="v1", display_name="专家A",
                sequence_no=2, enabled=True,
            ),
            ExpertTemplateDetail(
                template_id="tpl-disabled", version="v1", display_name="专家D",
                sequence_no=1, enabled=False,
            ),
        ],
    )


def test_apply_solution_honors_sequence_order_and_skips_disabled():
    """展开按 sequence_order 排序，且 enabled=False 的专家不生成 employee。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_ordered_solution_package())
    svc, emp, _, _, _ = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-ord"))

    # 禁用专家被跳过 → 只展开 2 个
    assert len(result.experts) == 2
    expanded_ids = {e.source_template_id for e in result.experts}
    assert "tpl-disabled" not in expanded_ids
    assert expanded_ids == {"tpl-a", "tpl-z"}
    # 方案实例记录的 employee_id 也应为 2 个
    assert len(result.solution_instance.expert_employee_ids) == 2
    # 实例中专家的展开顺序应按 sequence_no：tpl-a(2) 在前，tpl-z(5) 在后
    ordered_employee_ids = result.solution_instance.expert_employee_ids
    slug_a = emp.get(_ctx("t-a"), employee_id=ordered_employee_ids[0]).employee_slug
    slug_z = emp.get(_ctx("t-a"), employee_id=ordered_employee_ids[1]).employee_slug
    assert slug_a.endswith("_e0")
    assert slug_z.endswith("_e1")


# ---- AITEAM-356：Manager 端不可编辑已应用方案实例（PRD B06） ----


def test_manager_cannot_edit_solution_instance_after_apply():
    """回归：apply 后方案实例只读；服务层不再暴露 update_solution_instance。"""
    import manager_service.recruit_service as svc_mod
    assert not hasattr(svc_mod.RecruitService, "update_solution_instance"), (
        "AITEAM-356: Manager 端不应提供方案实例编辑能力"
    )


def test_apply_solution_preserves_collab_prompts_from_package():
    """F07 应用方案时，方案包携带的协作 prompts 落到方案实例。"""
    catalog = FakeOperatorCatalogClient()
    pkg = SolutionPackage(
        solution_id="sol-prompt", version="v1", display_name="方案",
        experts=[_expert_template()],
        planner_prompt="plan-p", subtask_prompt="sub-p", aggregate_prompt="agg-p",
    )
    catalog.seed_solution(pkg)
    svc, _, _, _, _ = _build_service(catalog)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-prompt"))
    assert result.solution_instance.planner_prompt == "plan-p"
    assert result.solution_instance.subtask_prompt == "sub-p"
    assert result.solution_instance.aggregate_prompt == "agg-p"


# ---- 追加测试：F06 未传 employee_slug 时后端自动生成 slug（PRD P03/P04）----

def test_recruit_expert_generates_slug_when_missing():
    """未传 employee_slug 时后端自动生成 slug（PRD P03/P04：实例标识服务端创建）."""
    template = ExpertTemplateDetail(
        template_id="tpl-auto", version="1", display_name="测试销售专家", persona="销售精英",
    )

    class FakeCat:
        def pull_expert_template(self, template_id, version=None):
            return template
        def pull_solution_package(self, solution_id, version=None):
            raise NotImplementedError
        def list_expert_templates(self):
            return [template]
        def list_solution_packages(self):
            return []

    svc = RecruitService(
        catalog=FakeCat(),
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=_FakeProviderRepo(),
    )
    ctx = TenantContext(tenant_id="t-a", enterprise_id="ent-a", user_id="owner-1", roles=["owner"])
    result = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-auto"))
    assert result.employee_slug, "应自动生成 slug"
    assert svc._employees.get_by_slug(ctx, employee_slug=result.employee_slug) is not None


def test_recruit_expert_generated_slugs_are_unique():
    """同一 tenant 多次不传 slug 时后端生成唯一 slug."""
    template = ExpertTemplateDetail(
        template_id="tpl-auto", version="1", display_name="销售 专家", persona=None,
    )

    class FakeCat:
        def pull_expert_template(self, template_id, version=None):
            return template
        def pull_solution_package(self, solution_id, version=None):
            raise NotImplementedError
        def list_expert_templates(self):
            return [template]
        def list_solution_packages(self):
            return []

    svc = RecruitService(
        catalog=FakeCat(),
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=_FakeProviderRepo(),
    )
    ctx = TenantContext(tenant_id="t-slug", enterprise_id="ent-slug", user_id="owner-1", roles=["owner"])
    r1 = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-auto"))
    r2 = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-auto"))
    assert r1.employee_slug != r2.employee_slug


def test_recruit_expert_explicit_slug_still_works():
    """向前兼容：显式传 employee_slug 仍按传入值落库（PRD 放宽而非移除）."""
    template = ExpertTemplateDetail(
        template_id="tpl-auto", version="1", display_name="销售专家", persona=None,
    )

    class FakeCat:
        def pull_expert_template(self, template_id, version=None):
            return template
        def pull_solution_package(self, solution_id, version=None):
            raise NotImplementedError
        def list_expert_templates(self):
            return [template]
        def list_solution_packages(self):
            return []

    svc = RecruitService(
        catalog=FakeCat(),
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=_FakeProviderRepo(),
    )
    ctx = TenantContext(tenant_id="t-exp", enterprise_id="ent-exp", user_id="owner-1", roles=["owner"])
    result = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-auto", employee_slug="my-custom-slug"))
    assert result.employee_slug == "my-custom-slug"


def test_recruit_expert_generated_slug_allowed_chars():
    """后端生成 slug 遵守 [a-z0-9_] 约束（与 repo unique slug 约定一致）."""
    # Mix English + CJK chars + punctuation -> CJK/non-ASCII dropped, keeps only [a-z0-9_]
    template = ExpertTemplateDetail(
        template_id="tpl-auto", version="1", display_name="企业 销售-顾问 · Alpha", persona=None,
    )

    class FakeCat:
        def pull_expert_template(self, template_id, version=None):
            return template
        def pull_solution_package(self, solution_id, version=None):
            raise NotImplementedError
        def list_expert_templates(self):
            return [template]
        def list_solution_packages(self):
            return []

    svc = RecruitService(
        catalog=FakeCat(),
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=_FakeProviderRepo(),
    )
    ctx = TenantContext(tenant_id="t-chars", enterprise_id="ent-chars", user_id="owner-1", roles=["owner"])
    result = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-auto"))
    slug = result.employee_slug
    assert slug and slug == slug.lower(), "slug 全小写"
    assert all(c.isalnum() or c == "_" for c in slug), "slug 仅允许 [a-z0-9_]"
    # ASCII-only 约束下中文不能进入 slug；空后回退到 template_id
    assert all(ord(c) < 128 for c in slug), "slug 必须 ASCII-only"


def test_recruit_expert_generated_slug_handles_ascii_template():
    """纯 ASCII display_name 场景：字符映射 + 去重正常工作."""
    template = ExpertTemplateDetail(
        template_id="tpl-sales", version="1", display_name="Enterprise Sales-Pro v2", persona=None,
    )

    class FakeCat:
        def pull_expert_template(self, template_id, version=None):
            return template
        def pull_solution_package(self, solution_id, version=None):
            raise NotImplementedError
        def list_expert_templates(self):
            return [template]
        def list_solution_packages(self):
            return []

    svc = RecruitService(
        catalog=FakeCat(),
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=_FakeProviderRepo(),
    )
    ctx = TenantContext(tenant_id="t-eng", enterprise_id="ent-eng", user_id="owner-1", roles=["owner"])
    result = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-sales"))
    assert result.employee_slug == "enterprise_sales_pro_v2"
    # 重复招募 -> 唯一后缀
    result2 = svc.recruit_expert(ctx, RecruitExpertRequest(template_id="tpl-sales"))
    assert result2.employee_slug.startswith("enterprise_sales_pro_v2_")
    assert result2.employee_slug != result.employee_slug


# ---- AITEAM-682：recruit/apply 时 default_model 自动匹配 provider_ref（resolver 验收）----


def _service_with_providers(
    catalog: OperatorCatalogPort, providers: "_FakeProviderRepo"
):
    svc = RecruitService(
        catalog=catalog,
        employees=_FakeEmployeeRepo(),
        grants=_FakeGrantRepo(),
        recruit=_FakeRecruitRepo(),
        orders=_FakeOrderRepo(),
        providers=providers,
    )
    return svc


# ---- explicit 路径 ----


def test_resolve_explicit_provider_ref_exists_sets_explicit_and_writes_ref():
    """recommended.provider_ref 有值且本 tenant 存在 → explicit，employee 写入该 ref。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())  # recommended_config.provider_ref="relay-default"
    providers = _FakeProviderRepo()
    providers.seed("relay-default", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = _service_with_providers(catalog, providers)

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"),
    )
    assert result.provider_match_status == "explicit"
    assert result.provider_match_candidates == ["relay-default"]
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref == "relay-default"
    assert row.model == "claude-opus-4-8"


def test_resolve_explicit_provider_ref_missing_raises_conflict_409():
    """recommended.provider_ref 有值但本 tenant 不存在 → V1 抛 409，避免落错误引用。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_expert_template())  # provider_ref="relay-default" 未 seed
    svc = _service_with_providers(catalog, _FakeProviderRepo())

    with pytest.raises(Conflict):
        svc.recruit_expert(
            _ctx("t-a"), RecruitExpertRequest(template_id="tpl-1", employee_slug="exp-a"),
        )


# ---- model 自动匹配路径（无 provider_ref）----


def _template_with_model_only(
    template_id="tpl-m", version="v1", display_name="M专家", model="claude-opus-4-8"
) -> ExpertTemplateDetail:
    return ExpertTemplateDetail(
        template_id=template_id, version=version, display_name=display_name,
        persona="p", recommended_config={"model": model},
    )


def test_resolve_model_single_match_sets_matched_and_writes_ref():
    """有 model、恰好 1 个 provider 支持且 enabled → matched，employee 自动写入 provider_ref + model。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_template_with_model_only(model="claude-opus-4-8"))
    providers = _FakeProviderRepo()
    providers.seed("only-one", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = _service_with_providers(catalog, providers)

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-m", employee_slug="exp-m"),
    )
    assert result.provider_match_status == "matched"
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref == "only-one"
    assert row.model == "claude-opus-4-8"
    assert result.provider_match_candidates == ["only-one"]


def test_resolve_model_no_match_creates_with_provider_ref_none_status_none():
    """有 model、本 tenant 无 provider 支持 → 仍创建 employee，provider_ref=None，status=none(待配置)。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_template_with_model_only(model="claude-opus-4-8"))
    svc = _service_with_providers(catalog, _FakeProviderRepo())  # 未 seed 任何 provider

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-m", employee_slug="exp-none"),
    )
    assert result.provider_match_status == "none"
    assert result.provider_match_candidates == []
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref is None
    assert row.model == "claude-opus-4-8"


def test_resolve_model_multiple_matches_ambiguous_no_random_pick():
    """有 model、多个 provider 支持 → ambiguous，不随机选择，provider_ref=None，保留 candidates。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_template_with_model_only(model="claude-opus-4-8"))
    providers = _FakeProviderRepo()
    providers.seed("p-a", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    providers.seed("p-b", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = _service_with_providers(catalog, providers)

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-m", employee_slug="exp-amb"),
    )
    assert result.provider_match_status == "ambiguous"
    assert set(result.provider_match_candidates) == {"p-a", "p-b"}
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref is None  # 不静默随机
    assert row.model == "claude-opus-4-8"


def test_resolve_ignores_disabled_provider_model():
    """provider 声明了该 model 但 enabled=False → 不参与匹配。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_template_with_model_only(model="claude-opus-4-8"))
    providers = _FakeProviderRepo()
    providers.seed("off", supported_models=[{"model": "claude-opus-4-8", "enabled": False}])
    svc = _service_with_providers(catalog, providers)

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-m", employee_slug="exp-off"),
    )
    assert result.provider_match_status == "none"
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref is None


def test_resolve_no_provider_ref_and_no_model_status_none():
    """无 provider_ref 且无 model → status=none，不查 provider。"""
    catalog = FakeOperatorCatalogClient()
    tpl = ExpertTemplateDetail(
        template_id="tpl-x", version="v1", display_name="X", persona="p",
        recommended_config={},
    )
    catalog.seed_expert(tpl)
    svc = _service_with_providers(catalog, _FakeProviderRepo())

    result = svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-x", employee_slug="exp-x"),
    )
    assert result.provider_match_status == "none"
    row = svc._employees.get(_ctx("t-a"), employee_id=result.employee_id)
    assert row.provider_ref is None
    assert row.model is None


# ---- 审计：recruit_event.detail 记录脱敏匹配决策 ----


def test_resolve_audit_detail_records_match_decision_no_secret():
    """recruit_event.detail 记录 default_model / provider_match_status / matched_provider_ref / candidates，不记 secret。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_expert(_template_with_model_only(model="claude-opus-4-8"))
    providers = _FakeProviderRepo()
    providers.seed("only-one", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = _service_with_providers(catalog, providers)

    svc.recruit_expert(
        _ctx("t-a"), RecruitExpertRequest(template_id="tpl-m", employee_slug="exp-audit"),
    )
    events = svc._recruit.list_recruit_events(_ctx("t-a"))
    assert len(events) == 1
    detail = events[0].detail
    assert detail["default_model"] == "claude-opus-4-8"
    assert detail["provider_match_status"] == "matched"
    assert detail["matched_provider_ref"] == "only-one"
    assert detail["candidate_provider_refs"] == ["only-one"]
    # 红线：不得记录 secret / 密文
    assert "secret" not in detail
    assert "encrypted_secret" not in detail


# ---- 两条路径共用同一个 resolver（apply_solution 逐专家匹配）----


def _mixed_solution_package() -> SolutionPackage:
    """一个方案含两个专家：一个单匹配、一个无匹配，验证逐专家独立匹配。"""
    return SolutionPackage(
        solution_id="sol-mix", version="v1", display_name="混合方案",
        experts=[
            ExpertTemplateDetail(
                template_id="tpl-hit", version="v1", display_name="有匹配",
                persona="p", recommended_config={"model": "claude-opus-4-8"},
            ),
            ExpertTemplateDetail(
                template_id="tpl-miss", version="v1", display_name="无匹配",
                persona="p", recommended_config={"model": "gpt-4o"},
            ),
        ],
    )


def test_apply_solution_each_expert_owns_provider_match():
    """apply_solution 展开多个专家时，每个专家独立走同一 resolver；单匹配写 ref，无匹配保留 None。"""
    catalog = FakeOperatorCatalogClient()
    catalog.seed_solution(_mixed_solution_package())
    providers = _FakeProviderRepo()
    providers.seed("only-claude", supported_models=[{"model": "claude-opus-4-8", "enabled": True}])
    svc = _service_with_providers(catalog, providers)

    result = svc.apply_solution(_ctx("t-a"), ApplySolutionRequest(solution_id="sol-mix"))
    assert len(result.experts) == 2
    by_template = {e.source_template_id: e for e in result.experts}

    hit = by_template["tpl-hit"]
    assert hit.provider_match_status == "matched"
    hit_row = svc._employees.get(_ctx("t-a"), employee_id=hit.employee_id)
    assert hit_row.provider_ref == "only-claude"
    assert hit_row.model == "claude-opus-4-8"

    miss = by_template["tpl-miss"]
    assert miss.provider_match_status == "none"
    miss_row = svc._employees.get(_ctx("t-a"), employee_id=miss.employee_id)
    assert miss_row.provider_ref is None
    assert miss_row.model == "gpt-4o"

    # 方案级审计也含逐专家 match_audits
    events = svc._recruit.list_recruit_events(_ctx("t-a"))
    assert len(events) == 1
    assert events[0].action == "apply_solution"
    assert len(events[0].detail["match_audits"]) == 2
    assert "secret" not in events[0].detail
