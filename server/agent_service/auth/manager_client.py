"""跨端 Manager 登录客户端（05 §5.3 窄通信面）。

经 `shared.service_client.ServiceClient` 调 Manager：
`POST {manager_url}/api/auth/login` 校验凭据 + `GET {manager_url}/api/auth/{tenant}/jwks.json`
领取验签公钥；返回 `(token, jwks)`。凭据错误抛 `Unauthorized`，不可达/契约异常抛 `ManagerUnreachable`。
若调用方未传 `tenant_hint`，自动调 `POST {manager_url}/api/auth/resolve-tenant-by-account`
解析员工账号所属 tenant，无需前端手工填企业/租户 ID（#382）。

红线：本客户端只接收 token + 验签材料，**不持任何签发能力**（D23）。
"""

from __future__ import annotations

from shared.errors import AppError, Conflict, Forbidden, NotFound, Unauthorized, ValidationProblem
from shared.service_client import ServiceClient

from .local_login import LoginRequest, ManagerUnreachable, PasswordResetRequest


class UnconfiguredManagerClient:
    """未配置 manager_url 时的安全默认：任何登录都按"不可达"拒绝。

    避免模块导入即触网，也避免在缺配置时静默放行。生产部署须注入 `RealManagerLoginClient`
    （manager_url + 服务身份）。
    """

    def login(self, req: LoginRequest) -> tuple[str, dict]:
        raise ManagerUnreachable(
            "manager login client 未配置（A0 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。"
        )

    def reset_password(self, req: "PasswordResetRequest") -> tuple[str, dict]:
        raise ManagerUnreachable(
            "manager login client 未配置（A0 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。"
        )


class RealManagerLoginClient:
    """生产实现：经 ServiceClient 调 Manager 登录端点（#174，05 §5.3）。

    - `POST /api/auth/login`：解出 envelope `data.token`；401 透传 `Unauthorized`，
      其它非 2xx / 网络错误归一为 `ManagerUnreachable`；缺 token 视为契约异常 → `ManagerUnreachable`。
    - `GET /api/auth/{tenant}/jwks.json`：领取验签公钥；`tenant` 取解析到的 tenant_id；
      获取失败 → `ManagerUnreachable`。
    - 若调用方未传 `tenant_hint`，经 `POST /api/auth/resolve-tenant-by-account` 自动解析
      员工账号所属 tenant_id，避免前端手工填企业/租户 ID（#382）；404 / 409 透传为 AppError；
      其它失败统一降级为 `ManagerUnreachable`。

    红线：只接收 token + jwks，不持签发能力（D23）。
    """

    def __init__(self, service_client: ServiceClient):
        self._sc = service_client

    def _resolve_tenant(self, account: str, tenant_hint: str | None) -> str:
        """解析 tenant_id：优先用调用方传入的 tenant_hint；空缺时按员工账号自动解析（#382）。

        404（账号未绑定任何 tenant）、409（账号属于多个 tenant，无法唯一确定）透传为
        `AppError`，由路由层按 status 映射到 problem+json；其它失败统一降级为
        `ManagerUnreachable`。
        """
        if tenant_hint and tenant_hint.strip():
            return tenant_hint.strip()
        try:
            resp = self._sc.post(
                "/api/auth/resolve-tenant-by-account",
                {"account": account},
            )
        except (NotFound, Conflict):
            raise  # 透传语义类错误：前端可据此给出明确提示（未绑定 / 多租户需明确企业）
        except (AppError, Exception) as exc:  # noqa: BLE001 网络/其它失败统一降级
            raise ManagerUnreachable(f"tenant resolution unreachable: {exc}") from exc
        data = (resp.get("data") or {}) if isinstance(resp, dict) else {}
        tenant_id = data.get("tenant_id")
        if not tenant_id:
            raise ManagerUnreachable("tenant resolution response missing tenant_id")
        return tenant_id

    def login(self, req: LoginRequest) -> tuple[str, dict]:
        # ① 解析 tenant_id：优先 tenant_hint，空缺时按员工账号自动解析（#382）。
        tenant = self._resolve_tenant(req.account, req.tenant_hint)

        # ② 校验凭据。401 是凭据错误（透传）；其它失败/不可达归一为 ManagerUnreachable。
        try:
            # Manager LoginInput 契约（manager_service/auth_service.py，extra="forbid"）：
            # 必填 tenant_id + account + password，不接受额外字段。tenant_hint 即定位到的
            # tenant_id（调用方传入），按服务端冻结 schema 以 tenant_id 提交，勿发 tenant_hint。
            resp = self._sc.post(
                "/api/auth/login",
                {
                    "tenant_id": tenant,
                    "account": req.account,
                    "password": req.password,
                },
            )
        except (Unauthorized, Forbidden):
            raise
        except (AppError, Exception) as exc:  # noqa: BLE001 网络/上游错误统一降级
            raise ManagerUnreachable(f"manager login unreachable: {exc}") from exc

        token = (resp.get("data") or {}).get("token")
        if not token:
            raise ManagerUnreachable("manager login response missing token")

        # ③ 领取验签公钥（JWKS）。tenant 已在 ① 解析得到。
        try:
            jwks = self._sc.get(f"/api/auth/{tenant}/jwks.json")
        except Unauthorized:
            raise
        except (AppError, Exception) as exc:  # noqa: BLE001
            raise ManagerUnreachable(f"manager jwks unreachable: {exc}") from exc

        return token, jwks

    def reset_password(self, req: "PasswordResetRequest") -> tuple[str, dict]:
        """经 Manager `POST /api/auth/owner-reset` 重置密码（公开端点，无需 token）。

        403（密码仍需重置等）/401（旧凭据错误）透传；其它失败归一为 ManagerUnreachable。
        成功后领取 JWKS，返回 (token, jwks) 供调用方缓存。tenant_hint 空缺时按员工账号自动解析（#382）。
        """
        tenant = self._resolve_tenant(req.account, req.tenant_hint)

        try:
            resp = self._sc.post(
                "/api/auth/owner-reset",
                {
                    "tenant_id": tenant,
                    "account": req.account,
                    "old_password": req.password,
                    "new_password": req.new_password,
                },
            )
        except (Unauthorized, Forbidden):
            raise
        except (AppError, Exception) as exc:  # noqa: BLE001
            raise ManagerUnreachable(f"manager reset_password unreachable: {exc}") from exc

        token = (resp.get("data") or {}).get("token")
        if not token:
            raise ManagerUnreachable("manager reset_password response missing token")

        try:
            jwks = self._sc.get(f"/api/auth/{tenant}/jwks.json")
        except (Unauthorized, Forbidden):
            raise
        except (AppError, Exception) as exc:  # noqa: BLE001
            raise ManagerUnreachable(f"manager jwks unreachable: {exc}") from exc

        return token, jwks


__all__ = ["UnconfiguredManagerClient", "RealManagerLoginClient", "Unauthorized", "Forbidden"]
