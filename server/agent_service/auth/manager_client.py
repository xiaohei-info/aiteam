"""跨端 Manager 登录客户端（A0 骨架，05 §5.3 窄通信面）。

A0 范围：对端 Manager 登录端点尚未联调，按工单"对端先用 mock/fake"提供占位实现，
让用户端本地主链可独立开发/测试。真实实现经 shared.service_client 调
`POST {manager_url}/api/auth/login`，解出 token + 验签材料；属后续联调工单。

红线：本客户端只接收 token + 验签材料，**不持任何签发能力**（D23）。
"""

from __future__ import annotations

from shared.errors import Unauthorized

from .local_login import LoginRequest, ManagerUnreachable


class UnconfiguredManagerClient:
    """未配置 manager_url 时的安全默认：任何登录都按"不可达"拒绝。

    避免模块导入即触网，也避免在缺配置时静默放行。生产部署须注入真实
    ServiceClient-backed 实现（manager_url + 服务身份）。
    """

    def login(self, req: LoginRequest) -> tuple[str, str]:
        raise ManagerUnreachable(
            "manager login client 未配置（A0 骨架）。配置 MANAGER_URL 并注入真实客户端后可用。"
        )


__all__ = ["UnconfiguredManagerClient", "Unauthorized"]
