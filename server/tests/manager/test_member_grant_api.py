"""成员/部门/角色 + member_grant 授权 API 边界与路由验收（issue #35；02 §10；03 §9.7）。

非 integration（无需 PG）覆盖：
- schema/契约：MemberGrant 形状、EnterpriseRole 枚举取值（禁旧 admin/manager/viewer）、resource_type 白名单。
- 路由受保护：无 token → 401 problem+json；DB 未配置 → 503（不静默）。
- 成员输出不回显凭据/secret。
- 角色取值经 EnterpriseRole 枚举约束（旧枚举被拒）。

integration（真 PG RLS）落 test_member_grant_isolation.py：跨租户授权串线被拒。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.enums import EnterpriseRole
from shared.contracts.grants import MemberGrant


def _client(db_url: str | None, admin_db_url: str | None = None) -> TestClient:
    # 与 test_auth_routes 同款：注入 settings 重建 app，含本卡新增 member/grants 路由。
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_member import router as member_router
    from manager_service.routes_grants import router as grants_router

    settings = Settings(
        tier="manager", service_name="aiteam-manager-service",
        db_url=db_url, admin_db_url=admin_db_url,
    )
    app = create_app(settings, manager_router)
    app.state._token_verifier = _dev_verifier()
    app.include_router(auth_router)
    app.include_router(member_router)
    app.include_router(grants_router)
    return TestClient(app)


def _dev_verifier():
    # dev 自包含 token，仅供测试（生产 tenant 公钥/JWKS，D23）。
    from shared.auth import DevTokenService, TokenClaims
    import time

    svc = DevTokenService()

    def issue(tenant_id: str, user_id: str, roles: list[str]) -> str:
        return svc.sign(TokenClaims(
            tenant_id=tenant_id, user_id=user_id, roles=roles,
            exp=int(time.time()) + 3600,
        ))

    svc.issue = issue  # type: ignore[attr-defined]
    return svc


# ---- 契约：MemberGrant 形状不被重定义（只 import shared.contracts.grants）----
def test_member_grant_contract_shape():
    """MemberGrant 契约字段与取值（04 §6.2，D12）。"""
    g = MemberGrant(
        id="g1", tenant_id="t1", resource_type="expert", resource_id="e1",
        department_ids=["d1"], member_ids=["m1"],
    )
    assert g.resource_type == "expert"
    assert g.department_ids == ["d1"]
    assert g.member_ids == ["m1"]
    assert g.tenant_id == "t1"


def test_enterprise_role_enum_no_legacy_values():
    """角色枚举禁用旧 admin/manager/viewer（03 §9.7，红线）。"""
    values = {r.value for r in EnterpriseRole}
    assert values == {"owner", "enterprise_admin", "finance_admin", "member"}
    assert "admin" not in values
    assert "manager" not in values
    assert "viewer" not in values


def test_member_create_rejects_legacy_role():
    """MemberCreate.roles 经 EnterpriseRole 枚举：旧角色值在反序列化时被拒。"""
    from manager_service.schemas import MemberCreate

    # 合法枚举值通过
    ok = MemberCreate(account="13800000000", initial_password="x", roles=[EnterpriseRole.MEMBER])
    assert ok.roles == [EnterpriseRole.MEMBER]

    # 旧 admin/manager/viewer 经枚举校验被拒（pydantic 转换非法枚举 → ValidationError）
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MemberCreate(account="13800000000", initial_password="x", roles=["admin"])  # type: ignore[list-item]


def test_resource_type_whitelist():
    """resource_type 白名单（对齐 MemberGrant 契约 expert|solution）。

    非法取值抛 ValidationProblem（422），经统一异常处理转 application/problem+json，
    不落 500（02 §11.2）。"""
    from shared.errors import ValidationProblem
    from manager_service.repository_member import validate_resource_type

    validate_resource_type("expert")
    validate_resource_type("solution")
    with pytest.raises(ValidationProblem):
        validate_resource_type("workspace")  # 非法取值被拒


def test_create_grant_rejects_invalid_resource_type_via_http():
    """覆盖盲区：POST /api/manager/grants 传非法 resource_type 走 HTTP 路由 → 422 problem+json。

    schema 层 Literal 约束在请求反序列化阶段即拦截（reviewer 指出此前仅 service 层直调覆盖，
    HTTP 路径未覆盖）。"""
    client = _client(None)
    verifier = _dev_verifier()
    token = verifier.issue("t1", "u1", ["owner"])
    resp = client.post(
        "/api/manager/grants",
        headers={"Authorization": f"Bearer {token}"},
        json={"resource_type": "workspace", "resource_id": "e1"},
    )
    assert resp.status_code == 422
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "validation_error"


# ---- 路由：受保护端点 401 / DB 未配置 503 ----
def test_departments_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/departments")
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "unauthorized"


def test_grants_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/grants")
    assert resp.status_code == 401
    assert resp.json()["code"] == "unauthorized"


def test_departments_without_db_returns_503():
    """有 token 但 DB 未配置 → 503（不静默放行，对齐 routes_auth 口径）。"""
    client = _client(None)
    verifier = _dev_verifier()
    token = verifier.issue("t1", "u1", ["owner"])
    resp = client.get("/api/manager/departments", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 503
    assert resp.json()["code"] == "manager_db_unconfigured"


def test_create_member_out_has_no_secret():
    """MemberOut 不回显凭据/secret（02 §11.2 错误体/响应体不含敏感字段）。"""
    from manager_service.schemas import MemberOut

    out = MemberOut(id="m1", display_name="alice", status="active", roles=["member"], department_ids=["d1"])
    dumped = out.model_dump()
    assert "secret" not in dumped
    assert "password" not in dumped


def test_routes_registered_in_openapi():
    """验收：成员/部门/授权 CRUD 路由全注册（OpenAPI 反映）。"""
    client = _client(None)
    spec = client.get("/openapi.json").json()
    expected = {
        "/api/manager/departments": {"post", "get"},
        "/api/manager/departments/{department_id}": {"get", "patch", "delete"},
        "/api/manager/members": {"post", "get"},
        "/api/manager/members/{member_id}": {"get", "patch", "delete"},
        "/api/manager/grants": {"post", "get"},
        "/api/manager/grants/{grant_id}": {"get", "patch", "delete"},
    }
    for path, methods in expected.items():
        assert path in spec["paths"], f"missing {path}"
        assert set(spec["paths"][path].keys()) == methods, f"{path} methods mismatch"
