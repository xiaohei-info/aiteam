"""跨端 Manager 登录客户端（05 §5.3 窄通信面）。

经 `shared.service_client.ServiceClient` 调 Manager：
`POST {manager_url}/api/auth/login` 校验凭据 + `GET {manager_url}/api/auth/{tenant}/jwks.json`
领取验签公钥；返回 `(token, jwks)`。凭据错误抛 `Unauthorized`，不可达/契约异常抛 `ManagerUnreachable`。

红线：本客户端只接收 token + 验签材料，**不持任何签发能力**（D23）。
"""

from __future__ import annotations

from shared.errors import AppError, Forbidden, Unauthorized, ValidationProblem
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
    - `GET /api/auth/{tenant}/jwks.json`：领取验签公钥；`tenant` 取 `req.tenant_hint or "default"`；
      获取失败 → `ManagerUnreachable`。

    红线：只接收 token + jwks，不持签发能力（D23）。
    """

    def __init__(self, service_client: ServiceClient):
        self._sc = service_client

    def login(self, req: LoginRequest) -> tuple[str, dict]:
        # ① 前置校验：tenant_hint 是 Manager LoginInput.tenant_id 的来源，空值会被
        # Manager Pydantic 拒绝（422）。fail fast 给明确提示，不发无意义网络请求（#258）。
        if not req.tenant_hint or not req.tenant_hint.strip():
            raise ValidationProblem("tenant_hint 必填，请填写企业定位提示（tenant_id）")

        # ② 校验凭据。401 是凭据错误（透传）；其它失败/不可达归一为 ManagerUnreachable。
        try:
            # Manager LoginInput 契约（manager_service/auth_service.py，extra="forbid"）：
            # 必填 tenant_id + account + password，不接受额外字段。tenant_hint 即定位到的
            # tenant_id（调用方传入），按服务端冻结 schema 以 tenant_id 提交，勿发 tenant_hint。
            resp = self._sc.post(
                "/api/auth/login",
                {
                    "tenant_id": req.tenant_hint,
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

        # ③ 领取验签公钥（JWKS）。tenant_hint 已在 ① 保证非空。
        tenant = req.tenant_hint
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
        成功后领取 JWKS，返回 (token, jwks) 供调用方缓存。
        """
        if not req.tenant_hint or not req.tenant_hint.strip():
            raise ValidationProblem("tenant_hint 必填，请填写企业定位提示（tenant_id）")

        try:
            resp = self._sc.post(
                "/api/auth/owner-reset",
                {
                    "tenant_id": req.tenant_hint,
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

        tenant = req.tenant_hint
        try:
            jwks = self._sc.get(f"/api/auth/{tenant}/jwks.json")
        except (Unauthorized, Forbidden):
            raise
        except (AppError, Exception) as exc:  # noqa: BLE001
            raise ManagerUnreachable(f"manager jwks unreachable: {exc}") from exc

        return token, jwks


__all__ = ["UnconfiguredManagerClient", "RealManagerLoginClient", "Unauthorized", "Forbidden"]
