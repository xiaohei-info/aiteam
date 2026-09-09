"""端配置（CLAUDE/AGENTS §13 横切·配置；09 §14.2 统一启动器 --tier）。

从环境变量读取，不复用旧 app/.env、不使用 HERMES_WEBUI_*（06 §7.3）。加载与 pydantic 校验完整；各端按需在此入口追加自有配置项（DB、上端地址、密钥引用等）。
各端按需扩展自己的配置项（DB、上端地址、密钥引用等），但统一经本 Settings 入口读取。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

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
    # 服务间认证共享密钥（平面③ 代码层守卫，03 §9.1）。未配置→守卫 fail-closed；
    # 仅显式 dev/development 占位值允许降级；test/production 必须真实鉴权。完整 mTLS 留部署层 follow-up。
    service_token: str | None = Field(default=None)
    service_client_timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    # 部署环境标记。运行时取值 dev | development | test | production；load_settings 拒绝缺失/未知值。
    aiteam_env: Literal["dev", "development", "test", "production"] = Field(
        default="development", description="部署环境：dev | development | test | production；运行时必须显式设置"
    )
    expose_public_docs: bool = Field(default=True, description="/docs /redoc 是否公网公开（02 §10.3.1）")

    @property
    def is_production(self) -> bool:
        """是否生产部署：AITEAM_ENV=production（runtime 必须真实，禁止 Fake）。"""
        return self.aiteam_env == "production"


def _database_target(value: str) -> tuple[str, int, str, str]:
    parsed = urlsplit(value)
    if parsed.scheme not in {"postgresql", "postgres"} or not parsed.hostname or not parsed.path.strip("/"):
        raise ValueError
    return parsed.hostname.lower(), parsed.port or 5432, parsed.path.strip("/"), parsed.username or ""


def _required_environment() -> Literal["dev", "development", "test", "production"]:
    raw = os.getenv("AITEAM_ENV")
    if raw is None or not raw.strip():
        raise ValueError("AITEAM_ENV must be explicitly set to dev, development, test, or production")
    if raw not in {"dev", "development", "test", "production"}:
        raise ValueError("AITEAM_ENV must be one of dev, development, test, or production")
    return raw  # type: ignore[return-value]


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
    environment = _required_environment()
    if resolved == "operation" and environment == "test" and os.getenv("DB_URL") and (not os.getenv("OPERATION_DB_URL") or not os.getenv("OPERATION_ADMIN_DB_URL")):
        raise ValueError("Operation requires OPERATION_DB_URL and OPERATION_ADMIN_DB_URL when a test database is configured")
    configured_db_url = (os.getenv("OPERATION_DB_URL") or os.getenv("DB_URL")) if resolved == "operation" else os.getenv("DB_URL")
    configured_admin_db_url = (os.getenv("OPERATION_ADMIN_DB_URL") or os.getenv("ADMIN_DB_URL")) if resolved == "operation" else os.getenv("ADMIN_DB_URL")
    if environment == "production":
        db_url = configured_db_url or ""
        admin_db_url = configured_admin_db_url or ""
        try:
            db_user = urlsplit(db_url).username
            admin_user = urlsplit(admin_db_url).username
        except ValueError as exc:
            raise ValueError("production DB_URL/ADMIN_DB_URL must be valid PostgreSQL URLs") from exc
        if not db_url or not admin_db_url or db_user != "app_rw" or not admin_user or admin_user == "app_rw":
            raise ValueError("production DB_URL must use app_rw and ADMIN_DB_URL must use a distinct migration role")
        if resolved == "operation" and (not os.getenv("OPERATION_DB_URL") or not os.getenv("OPERATION_ADMIN_DB_URL")):
            raise ValueError("production Operation requires OPERATION_DB_URL and OPERATION_ADMIN_DB_URL")
        manager_db_name = os.getenv("MANAGER_DB_NAME") or os.getenv("POSTGRES_DB") or "manager_control_db"
        operation_db_name = os.getenv("OPERATION_DB_NAME") or "oper"
        if manager_db_name == operation_db_name:
            raise ValueError("production Manager and Operation databases must be distinct")
        expected_name = operation_db_name if resolved == "operation" else manager_db_name
        if _database_target(db_url)[2] != expected_name or _database_target(admin_db_url)[2] != expected_name:
            raise ValueError("production database DSNs do not match their tier database name")
        for paired in ((os.getenv("DB_URL"), os.getenv("OPERATION_DB_URL")), (os.getenv("ADMIN_DB_URL"), os.getenv("OPERATION_ADMIN_DB_URL"))):
            if paired[0] and paired[1] and _database_target(paired[0])[:3] == _database_target(paired[1])[:3]:
                raise ValueError("production Manager and Operation DSNs must target distinct databases")
    legacy_tenant = os.getenv("MANAGER_TENANT_ID")
    if legacy_tenant and str(legacy_tenant).strip():
        logger.warning(
            "MANAGER_TENANT_ID is ignored; Manager tenants are selected per session, not process binding"
        )
    # Operation owns the separate `oper` database; its process-specific names
    # are explicit so a shared shell cannot accidentally route both tiers to
    # the Manager database. The generic names remain a dev/test compatibility
    # fallback for direct unit construction.
    return Settings(
        tier=resolved,  # type: ignore[arg-type]
        service_name=f"aiteam-{resolved}-service",
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        db_url=configured_db_url,
        admin_db_url=configured_admin_db_url,
        app_rw_password=os.getenv("APP_RW_PASSWORD"),
        manager_data_root=Path(os.getenv("AITEAM_MANAGER_DATA_ROOT") or (Path.cwd() / ".data" / "manager")),
        manager_url=os.getenv("MANAGER_URL"),
        operator_url=os.getenv("OPERATOR_URL"),
        agent_url=os.getenv("AGENT_URL"),
        service_token=os.getenv("SERVICE_TOKEN"),
        service_client_timeout_ms=_bounded_timeout_ms(os.getenv("SERVICE_CLIENT_TIMEOUT_MS")),
        aiteam_env=environment,
        expose_public_docs=os.getenv("EXPOSE_PUBLIC_DOCS", "1") not in ("0", "false", "False"),
    )


def _csv(raw: str | None) -> tuple[str, ...]:
    """逗号分隔环境变量值 → 去空白去空项的元组。"""
    if not raw:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())
