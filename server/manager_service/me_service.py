"""当前登录者的「我是谁」：企业名 / 企业代码 / 脱敏账号 / 角色 / 是否有密码 / 密码策略（R8、R9）。

只读，任何角色都可访问；只返回展示和自助改密所需的最小信息：
不返回完整账号、密码哈希、会话或其他成员的信息。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from shared.contracts.tenancy import TenantContext

from . import auth_password_policy as policy


def mask_account(account: str) -> str:
    """手机号保留前 3 后 4；其它账号只保留首字符。"""
    if not account:
        return ""
    if len(account) >= 11 and account.isdigit():
        return f"{account[:3]}****{account[-4:]}"
    return account[0] + "*" * min(3, len(account) - 1)


def password_policy() -> dict[str, Any]:
    return {
        "min_length": policy.min_length(),
        "require_upper": True,
        "require_lower": True,
        "require_digit": True,
        "require_symbol": True,
        "max_age_days": policy.max_age_days(),
    }


class MeService:
    def __init__(
        self, *, settings, auth, registry_code: Callable[[str], str | None],
        tenant_status: Callable[[str], str] | None = None,
    ):
        self._settings = settings
        self._auth = auth
        self._registry_code = registry_code
        self._tenant_status = tenant_status

    def _status(self, tenant_id: str) -> str:
        """企业状态只用于顶栏提示（真正的拦截在入口中间件）；读不到按正常处理，不让页面失败。"""
        if self._tenant_status is None:
            return "active"
        try:
            return self._tenant_status(tenant_id) or "active"
        except Exception:  # noqa: BLE001 - 展示用，尽力而为
            return "active"

    def get(self, ctx: TenantContext) -> dict[str, Any]:
        row = self._settings.get_settings(ctx)
        summary = self._auth.find_account_summary(ctx, user_id=ctx.user_id)
        account, has_password = summary if summary else ("", False)
        return {
            # 空名当作未设置：前端回退显示企业代码，管理员可在设置里补名称。
            "enterprise_name": (row.enterprise_name or None) if row else None,
            "enterprise_code": self._registry_code(ctx.tenant_id),
            "account_masked": mask_account(account),
            "roles": list(ctx.roles),
            "tenant_status": self._status(ctx.tenant_id),
            "has_password": has_password,
            "password_policy": password_policy(),
        }
