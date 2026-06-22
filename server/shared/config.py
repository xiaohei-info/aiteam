"""端配置（CLAUDE/AGENTS §13 横切·配置；09 §14.2 统一启动器 --tier）。

从环境变量读取，不复用旧 app/.env、不使用 HERMES_WEBUI_*（06 §7.3）。仅最小骨架；
各端按需扩展自己的配置项（DB、上端地址、密钥引用等），但统一经本 Settings 入口读取。
"""

from __future__ import annotations

import os
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Tier = Literal["operation", "manager", "agent"]
_VALID_TIERS = ("operation", "manager", "agent")


class Settings(BaseModel):
    """单端运行配置。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tier: Tier
    service_name: str
    log_level: str = "INFO"
    db_url: str | None = Field(
        default=None,
        description="业务连接串：以受约束角色 app_rw（非 superuser/非 BYPASSRLS）身份建连，跑租户 RLS SQL；骨架期可空",
    )
    admin_db_url: str | None = Field(
        default=None,
        description="管理连接串：超管/DDL owner 身份，仅供迁移/建角色/DDL 与控制面表（如签名私钥）直读直写；不跑租户业务 SQL",
    )
    app_rw_password: str | None = Field(
        default=None,
        description="迁移时为 app_rw 设置的 LOGIN 口令（来源 env，禁止硬编码）；业务 DSN 已内含该口令，本项仅供管理连接在迁移中下发",
    )
    # 跨端地址（窄通信面，05 §5.5）：Agent 需 manager_url；Manager 需 operator_url。
    manager_url: str | None = Field(default=None)
    operator_url: str | None = Field(default=None)
    # 服务间认证共享密钥（平面③ 代码层守卫，03 §9.1）。未配置→守卫 fail-open（dev 友好）；
    # 配置后 fail-closed：跨端收端校验 X-Service-Token 匹配。完整 mTLS 留部署层 follow-up。
    service_token: str | None = Field(default=None)
    # Agent 用户端本地库文件路径（SQLite）。未配置→内存实现（dev/测试默认，不落文件）；
    # 配置后落 SQLite 本机库，重启不丢（04 用户端轻量本地库）。
    agent_db_path: str | None = Field(default=None)
    # Agent 选定 runtime（06 §7.6）。未配置→Fake runtime（dev/测试默认）；配置后经 Gateway
    # 装配真实 Driver/Executor（如 hermes/codex/claude_code/...），不静默切换。
    agent_runtime: str | None = Field(default=None)
    # Runtime Worker 子进程隔离工作目录根（§13）。每 run 在其下建独立 cwd。
    agent_runs_root: str | None = Field(default=None)
    # 进程启动期是否自启动 loop 调度后台循环（06 §7.6）。默认否（dev/测试用手动触发）。
    agent_loop_autostart: bool = Field(default=False)
    # 放行给 runtime 子进程的环境变量名（§13 凭据最小注入）：沙箱默认脱敏全部 env，
    # provider 凭据（如 *_API_KEY）须经此显式 allowlist 从宿主 env 注入，否则 runtime 无法鉴权。
    # 仅传变量名，值从宿主 os.environ 取，不内联明文（D18）。provider_ref 全量解析见后续。
    agent_runtime_env_passthrough: tuple[str, ...] = Field(default=())
    expose_public_docs: bool = Field(default=True, description="/docs /redoc 是否公网公开（02 §10.3.1）")


def load_settings(tier: Tier | None = None) -> Settings:
    """从环境构造 Settings。tier 入参优先，其次 APP_TIER 环境变量。"""
    resolved = tier or os.getenv("APP_TIER")
    if resolved not in _VALID_TIERS:
        raise ValueError(f"无效 tier={resolved!r}，应为 {_VALID_TIERS} 之一（见 09 §14.2）")
    return Settings(
        tier=resolved,  # type: ignore[arg-type]
        service_name=f"aiteam-{resolved}-service",
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        db_url=os.getenv("DB_URL"),
        admin_db_url=os.getenv("ADMIN_DB_URL"),
        app_rw_password=os.getenv("APP_RW_PASSWORD"),
        manager_url=os.getenv("MANAGER_URL"),
        operator_url=os.getenv("OPERATOR_URL"),
        service_token=os.getenv("SERVICE_TOKEN"),
        agent_db_path=os.getenv("AGENT_DB_PATH"),
        agent_runtime=os.getenv("AGENT_RUNTIME"),
        agent_runs_root=os.getenv("AGENT_RUNS_ROOT"),
        agent_loop_autostart=os.getenv("AGENT_LOOP_AUTOSTART", "0") not in ("0", "false", "False"),
        agent_runtime_env_passthrough=_csv(os.getenv("AGENT_RUNTIME_ENV_PASSTHROUGH")),
        expose_public_docs=os.getenv("EXPOSE_PUBLIC_DOCS", "1") not in ("0", "false", "False"),
    )


def _csv(raw: str | None) -> tuple[str, ...]:
    """逗号分隔环境变量值 → 去空白去空项的元组。"""
    if not raw:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())
