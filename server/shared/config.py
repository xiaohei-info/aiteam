"""端配置（CLAUDE/AGENTS §13 横切·配置；09 §14.2 统一启动器 --tier）。

从环境变量读取，不复用旧 app/.env、不使用 HERMES_WEBUI_*（06 §7.3）。加载与 pydantic 校验完整；各端按需在此入口追加自有配置项（DB、上端地址、密钥引用等）。
各端按需扩展自己的配置项（DB、上端地址、密钥引用等），但统一经本 Settings 入口读取。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Tier = Literal["operation", "manager"]
_VALID_TIERS = ("operation", "manager")


class Settings(BaseModel):
    """单端运行配置。"""

    model_config = ConfigDict(extra="forbid", frozen=True)

    tier: Tier
    service_name: str
    log_level: str = "INFO"
    db_url: str | None = Field(
        default=None,
        description="业务连接串：以受约束角色 app_rw（非 superuser/非 BYPASSRLS）身份建连，跑租户 RLS SQL；dev 模式（未配 db_url）可空，生产须填充业务连接串",
    )
    admin_db_url: str | None = Field(
        default=None,
        description="管理连接串：超管/DDL owner 身份，仅供迁移/建角色/DDL 与控制面表（如签名私钥）直读直写；不跑租户业务 SQL",
    )
    app_rw_password: str | None = Field(
        default=None,
        description="迁移时为 app_rw 设置的 LOGIN 口令（来源 env，禁止硬编码）；业务 DSN 已内含该口令，本项仅供管理连接在迁移中下发",
    )
    # Manager durable knowledge source. Compose mounts the named managerdata volume here.
    manager_data_root: Path = Field(default_factory=lambda: Path.cwd() / ".data" / "manager")
    # 跨端地址（窄通信面，05 §5.5）：Agent 需 manager_url；Manager 需 operator_url。
    manager_url: str | None = Field(default=None)
    operator_url: str | None = Field(default=None)
    agent_url: str | None = Field(default=None)
    # 服务间认证共享密钥（平面③ 代码层守卫，03 §9.1）。未配置→守卫 fail-open（dev 友好）；
    # 配置后 fail-closed：跨端收端校验 X-Service-Token 匹配。完整 mTLS 留部署层 follow-up。
    service_token: str | None = Field(default=None)
    service_client_timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    # 部署环境标记。取值 dev | test | production；未配置按 dev 处理。
    aiteam_env: str | None = Field(default=None, description="部署环境：dev | test | production；未配置=dev")
    expose_public_docs: bool = Field(default=True, description="/docs /redoc 是否公网公开（02 §10.3.1）")

    @property
    def is_production(self) -> bool:
        """是否生产部署：AITEAM_ENV=production（runtime 必须真实，禁止 Fake）。"""
        return self.aiteam_env == "production"


def _bounded_timeout_ms(raw: str | None) -> int:
    try:
        return max(1_000, min(int(raw or "30000"), 120_000))
    except ValueError:
        return 30_000


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
        manager_data_root=Path(os.getenv("AITEAM_MANAGER_DATA_ROOT") or (Path.cwd() / ".data" / "manager")),
        manager_url=os.getenv("MANAGER_URL"),
        operator_url=os.getenv("OPERATOR_URL"),
        agent_url=os.getenv("AGENT_URL"),
        service_token=os.getenv("SERVICE_TOKEN"),
        service_client_timeout_ms=_bounded_timeout_ms(os.getenv("SERVICE_CLIENT_TIMEOUT_MS")),
        aiteam_env=os.getenv("AITEAM_ENV"),
        expose_public_docs=os.getenv("EXPOSE_PUBLIC_DOCS", "1") not in ("0", "false", "False"),
    )


def _csv(raw: str | None) -> tuple[str, ...]:
    """逗号分隔环境变量值 → 去空白去空项的元组。"""
    if not raw:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())
