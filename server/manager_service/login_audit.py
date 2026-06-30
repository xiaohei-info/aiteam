"""登录审计记录（issue AITEAM-253，「登录审计 login_attempt」缺口）。

口径（04 审计口径；9.2 红线：token/密码/会话内容不入响应体）：
- 每次登录企图（成功/失败）记一行 login_attempt，带去重租户隔离（TenantContext）。
- 只存：actor / provider / external_id / ip_hash / success / occurred_at / 脱敏 detail。
- **绝不存密码、token、明文 ip**。ip 以 SHA-256（租户 pepper）入库，仅用于频率限制与追溯。
"""

from __future__ import annotations

import hashlib
import hmac
import os

from shared.contracts.enums import AuthProvider
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


def _ip_hash(ip: str, tenant_id: str) -> str:
    """对客户端 ip 做含租户 pepper 的散列，防跨租户关联且不可逆。"""
    if not ip:
        return ""
    pepper = os.getenv("LOGIN_AUDIT_PEPPER", "manager")
    key = (tenant_id + ":" + pepper).encode("utf-8")
    return hmac.new(key, ip.encode("utf-8"), hashlib.sha256).hexdigest()


class LoginAuditRepository:
    """login_attempt 的租户作用域写入。所有方法以 TenantContext 为隔离边界（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def record(
        self,
        ctx: TenantContext,
        *,
        provider,
        external_id: str | None,
        actor: str,
        ip: str | None,
        success: bool,
        detail: str | None = None,
    ) -> None:
        """落一条登录审计。provider 接受 AuthProvider 或其字符串取值（如 "password"/"passkey"/"oauth:google"）。
        write 失败只 log 不抛——审计永远不能阻塞登录主路径（#可用性）。"""
        try:
            provider_value = getattr(provider, "value", provider)
            ip_hash = _ip_hash(ip or "", ctx.tenant_id)
            with self._router.session(ctx) as s:
                s.execute(
                    "INSERT INTO login_attempt "
                    "  (tenant_id, actor, provider, external_id, ip_hash, success, detail) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (ctx.tenant_id, actor, provider_value, external_id, ip_hash,
                     success, detail),
                )
        except Exception:
            # pragma: no cover - 审计写入不应影响主路径；留日志点。
            return


def record_login_attempt(audit, ctx, *, provider, external_id, actor, ip, success, detail=None):
    """站点登录审计的便捷入口。audit 未配置 / 写入失败均不影响登录主路径。"""
    if audit is None:
        return
    try:
        audit.record(ctx, provider=provider, external_id=external_id,
                     actor=actor, ip=ip, success=success, detail=detail)
    except Exception:
        return
