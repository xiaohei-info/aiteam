"""端配置（CLAUDE/AGENTS §13 横切·配置；09 §14.2 统一启动器 --tier）。

从环境变量读取，不复用旧 app/.env、不使用 HERMES_WEBUI_*（06 §7.3）。加载与 pydantic 校验完整；各端按需在此入口追加自有配置项（DB、上端地址、密钥引用等）。
各端按需扩展自己的配置项（DB、上端地址、密钥引用等），但统一经本 Settings 入口读取。
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

Tier = Literal["operation", "manager"]
_VALID_TIERS = ("operation", "manager")
_DEFAULT_PEER_AUDIENCE = {
    "operation": "aiteam-manager-service",
    "manager": "aiteam-operation-service",
}


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
    # 服务间认证：生产使用短期 RS256 service identity；SERVICE_TOKEN 仅显式
    # dev/test 兼容。完整 TLS/allowlist 仍由部署层提供，代码不把它们降级为身份。
    service_token: str | None = Field(default=None)
    service_auth_mode: Literal["auto", "signed", "legacy"] = Field(default="auto")
    service_identity_private_key: str | None = Field(default=None, repr=False)
    service_identity_public_keys: dict[str, str] = Field(default_factory=dict, repr=False)
    service_identity_trust: dict[str, dict[str, Any]] = Field(default_factory=dict, repr=False)
    service_identity_key_id: str | None = Field(default=None)
    service_identity_issuer: str | None = Field(default=None)
    service_identity_audience: str | None = Field(default=None)
    service_identity_peer_audience: str | None = Field(default=None)
    service_identity_origin: str | None = Field(default=None)
    service_identity_deployment_id: str | None = Field(default=None)
    service_identity_ttl_seconds: int = Field(default=30, ge=1, le=60)
    service_identity_clock_skew_seconds: int = Field(default=30, ge=0, le=30)
    service_identity_allowed_origins: tuple[str, ...] = Field(default_factory=tuple)
    service_identity_allowed_enterprises: tuple[str, ...] = Field(default_factory=tuple)
    service_identity_allowed_tenants: tuple[str, ...] = Field(default_factory=tuple)
    service_identity_allowed_scopes: tuple[str, ...] = Field(default_factory=tuple)
    # The bounded replay implementation is process-local. Production launch
    # must explicitly acknowledge a single receiver; multi-instance replay
    # needs an approved shared mechanism instead.
    service_identity_single_instance: bool = Field(default=False)
    # Explicit TEST-only onboarding verification switch. Production never reads
    # this as an authorization bypass.
    test_onboarding_writes_enabled: bool = Field(default=False)
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


def service_peer_audience(settings: Settings) -> str:
    """Return the configured peer audience, with a dev/test-only contract default."""

    if settings.service_identity_peer_audience:
        return settings.service_identity_peer_audience
    if settings.is_production:
        return ""
    return _DEFAULT_PEER_AUDIENCE[settings.tier]


def service_client_kwargs(settings: Settings) -> dict[str, Any]:
    """Return explicit tier-validated signer inputs for an outbound client.

    Production callers must not fall back to generic ambient
    ``SERVICE_IDENTITY_*`` environment variables: Settings has already selected
    the tier-prefixed values and validated their shape at launch.
    """

    return {
        "service_identity": settings.service_name,
        "service_token": settings.service_token,
        "service_private_key": settings.service_identity_private_key,
        "service_key_id": settings.service_identity_key_id,
        "service_issuer": settings.service_identity_issuer,
        "service_deployment_id": settings.service_identity_deployment_id,
        "service_ttl_seconds": settings.service_identity_ttl_seconds,
        "service_audience": service_peer_audience(settings),
        "service_origin": settings.service_identity_origin,
        "service_auth_mode": settings.service_auth_mode,
        "aiteam_env": settings.aiteam_env,
        "load_env_signer": False,
    }


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


def _tier_env(name: str, tier: Tier | None = None) -> str | None:
    """Read tier-specific service identity config before the generic alias."""

    if tier:
        value = os.getenv(f"{tier.upper()}_{name}")
        if value is not None:
            return value
    return os.getenv(name)


def _optional_secret(name: str, tier: Tier | None = None) -> str | None:
    value = _tier_env(name, tier)
    return value if value and value.strip() else None


def _json_mapping(name: str, tier: Tier | None = None) -> dict[str, Any]:
    raw = _tier_env(name, tier)
    if not raw or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{name} must be a JSON object") from exc
    if not isinstance(value, dict) or any(not isinstance(key, str) or not key.strip() for key in value):
        raise ValueError(f"{name} must be a JSON object keyed by non-empty strings")
    return value


def _service_auth_mode(tier: Tier | None = None) -> Literal["auto", "signed", "legacy"]:
    raw = (_tier_env("SERVICE_AUTH_MODE", tier) or "auto").strip().lower()
    if raw not in {"auto", "signed", "legacy"}:
        raise ValueError("SERVICE_AUTH_MODE must be auto, signed, or legacy")
    return raw  # type: ignore[return-value]


def _service_identity_ttl(tier: Tier | None = None) -> int:
    raw = _tier_env("SERVICE_IDENTITY_TTL_SECONDS", tier) or "30"
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("SERVICE_IDENTITY_TTL_SECONDS must be an integer") from exc
    if not 1 <= value <= 60:
        raise ValueError("SERVICE_IDENTITY_TTL_SECONDS must be between 1 and 60")
    return value


def _service_identity_clock_skew(tier: Tier | None = None) -> int:
    raw = _tier_env("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS", tier) or "30"
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS must be an integer") from exc
    if not 0 <= value <= 30:
        raise ValueError("SERVICE_IDENTITY_CLOCK_SKEW_SECONDS must be between 0 and 30")
    return value


def _boolean(name: str, tier: Tier | None = None, *, default: bool = False) -> bool:
    raw = _tier_env(name, tier)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def validate_production_service_identity(settings: Settings) -> None:
    """Fail before launch unless production has a complete signed trust setup."""

    if not settings.is_production:
        return
    required = {
        "SERVICE_AUTH_MODE": settings.service_auth_mode,
        "SERVICE_IDENTITY_PRIVATE_KEY": settings.service_identity_private_key,
        "SERVICE_IDENTITY_KEY_ID": settings.service_identity_key_id,
        "SERVICE_IDENTITY_ISSUER": settings.service_identity_issuer,
        "SERVICE_IDENTITY_AUDIENCE": settings.service_identity_audience,
        "SERVICE_IDENTITY_PEER_AUDIENCE": settings.service_identity_peer_audience,
        "SERVICE_IDENTITY_ORIGIN": settings.service_identity_origin,
        "SERVICE_IDENTITY_DEPLOYMENT_ID": settings.service_identity_deployment_id,
        "SERVICE_IDENTITY_TRUST_JSON": settings.service_identity_trust,
    }
    if settings.service_auth_mode != "signed":
        raise ValueError("production service authentication requires SERVICE_AUTH_MODE=signed")
    if any(value is None or value == "" or value == {} for value in required.values()):
        raise ValueError("production signed service identity/trust configuration is incomplete")
    now = int(time.time())
    if not any(
        isinstance(entry, dict)
        and entry.get("status") in {"active", "next"}
        and isinstance(entry.get("not_before"), int)
        and isinstance(entry.get("expires_at"), int)
        and entry["not_before"] <= now + settings.service_identity_clock_skew_seconds
        and entry["expires_at"] > now
        and not (
            isinstance(entry.get("revoked_at"), int)
            and entry["revoked_at"] <= now
        )
        for entry in settings.service_identity_trust.values()
    ):
        raise ValueError("production service identity trust manifest has no currently valid key")
    if not settings.service_identity_single_instance:
        raise ValueError(
            "production service identity replay protection requires SERVICE_IDENTITY_SINGLE_INSTANCE=true"
        )
    from shared.service_identity import ServiceIdentitySigner, ServiceIdentityVerifier, canonical_origin

    try:
        canonical_origin(settings.service_identity_origin or "", require_https=True)
        peer_url = settings.manager_url if settings.tier == "operation" else settings.operator_url
        canonical_origin(peer_url or "", require_https=True)
        ServiceIdentitySigner(
            settings.service_identity_private_key or "",
            kid=settings.service_identity_key_id or "",
            issuer=settings.service_identity_issuer or "",
            subject=settings.service_name,
            deployment_id=settings.service_identity_deployment_id or "",
            audience=settings.service_identity_audience,
            origin=settings.service_identity_origin,
            ttl_seconds=settings.service_identity_ttl_seconds,
        )
        verifier = ServiceIdentityVerifier.from_settings(settings)
        if verifier is None:
            raise ValueError("production service identity trust manifest is missing")
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid production signed service identity/trust configuration") from exc


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
    settings = Settings(
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
        service_auth_mode=_service_auth_mode(resolved),
        service_identity_private_key=_optional_secret("SERVICE_IDENTITY_PRIVATE_KEY", resolved),
        service_identity_public_keys=_json_mapping("SERVICE_IDENTITY_PUBLIC_KEYS", resolved),
        service_identity_trust=_json_mapping("SERVICE_IDENTITY_TRUST_JSON", resolved),
        service_identity_key_id=_optional_secret("SERVICE_IDENTITY_KEY_ID", resolved),
        service_identity_issuer=_optional_secret("SERVICE_IDENTITY_ISSUER", resolved),
        service_identity_audience=_optional_secret("SERVICE_IDENTITY_AUDIENCE", resolved),
        service_identity_peer_audience=_optional_secret("SERVICE_IDENTITY_PEER_AUDIENCE", resolved),
        service_identity_origin=_optional_secret("SERVICE_IDENTITY_ORIGIN", resolved),
        service_identity_deployment_id=_optional_secret("SERVICE_IDENTITY_DEPLOYMENT_ID", resolved),
        service_identity_ttl_seconds=_service_identity_ttl(resolved),
        service_identity_clock_skew_seconds=_service_identity_clock_skew(resolved),
        service_identity_allowed_origins=_csv(_tier_env("SERVICE_IDENTITY_ALLOWED_ORIGINS", resolved)),
        service_identity_allowed_enterprises=_csv(_tier_env("SERVICE_IDENTITY_ALLOWED_ENTERPRISES", resolved)),
        service_identity_allowed_tenants=_csv(_tier_env("SERVICE_IDENTITY_ALLOWED_TENANTS", resolved)),
        service_identity_allowed_scopes=_csv(_tier_env("SERVICE_IDENTITY_ALLOWED_SCOPES", resolved)),
        service_identity_single_instance=_boolean("SERVICE_IDENTITY_SINGLE_INSTANCE", resolved),
        test_onboarding_writes_enabled=_boolean("AITEAM_TEST_ENABLE_ONBOARDING_WRITES", resolved),
        service_client_timeout_ms=_bounded_timeout_ms(os.getenv("SERVICE_CLIENT_TIMEOUT_MS")),
        aiteam_env=environment,
        expose_public_docs=os.getenv("EXPOSE_PUBLIC_DOCS", "1") not in ("0", "false", "False"),
    )
    validate_production_service_identity(settings)
    return settings


def _csv(raw: str | None) -> tuple[str, ...]:
    """逗号分隔环境变量值 → 去空白去空项的元组。"""
    if not raw:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())
