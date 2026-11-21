"""Namespace / provenance / SKILL.md name of tenant catalog entries (design 2026-11-20「技能MCP命名空间出处与更新提示」§4.1).

Display-only: identifiers (skill_id, MCP ref) never change. Platform rows carry what Operator said when they were
installed or updated (``config.namespace`` / ``config.provenance``); enterprise rows take the enterprise's current
name, so a rename shows everywhere at once.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from shared.capability_namespace import (
    PLATFORM_NAMESPACE,
    as_edited,
    clawhub_provenance,
    namespace_for,
    normalize_provenance,
    origin_provenance,
    platform_provenance,
    qualified_label,
)
from shared.contracts.tenancy import TenantContext

EnterpriseNamespace = Callable[[TenantContext], str]


def skill_origin(config: Any, *, skill_id: str, enterprise: str) -> dict[str, Any]:
    """{namespace, provenance, name} of one skill_catalog row."""
    cfg = config if isinstance(config, dict) else {}
    if cfg.get("source") == "operator":
        provenance = normalize_provenance(cfg.get("provenance"))
        owner, slug = str(cfg.get("owner") or ""), str(cfg.get("slug") or "")
        if provenance is None and "namespace" not in cfg and owner and owner != "platform" and slug:
            provenance = clawhub_provenance(owner, slug)  # installed before Operator sent provenance: a ClawHub skill
        namespace = cfg["namespace"] if isinstance(cfg.get("namespace"), str) else namespace_for(PLATFORM_NAMESPACE, provenance)
        return {"namespace": namespace, "provenance": provenance, "name": str(cfg.get("skill_name") or slug or skill_id)}
    provenance = normalize_provenance(cfg.get("provenance")) if "provenance" in cfg else origin_provenance(cfg.get("origin"))
    return {"namespace": namespace_for(enterprise, provenance), "provenance": provenance, "name": skill_id}


def import_provenance(origin_kind: str, origin_url: str, clawhub: dict | None, existing_config: Any,
                      forked: dict | None) -> dict | None:
    """Provenance stored with an enterprise import or edit.

    An edited copy of a platform skill cites it; content taken as is from ClawHub / an address cites that place;
    anything else (folder, zip, paste, editor) is our content — it keeps citing what it was originally taken from,
    now as 改自.
    """
    if forked is not None:
        return forked
    if origin_kind == "clawhub" and clawhub and clawhub.get("owner") and clawhub.get("slug"):
        return clawhub_provenance(str(clawhub["owner"]), str(clawhub["slug"]))
    if origin_kind == "url" and origin_url:
        return origin_provenance({"kind": "url", "url": origin_url})
    cfg = existing_config if isinstance(existing_config, dict) else {}
    previous = normalize_provenance(cfg.get("provenance")) if "provenance" in cfg else origin_provenance(cfg.get("origin"))
    return as_edited(previous)


def fork_provenance(platform_config: Any, *, skill_id: str, version: str) -> dict:
    """What an enterprise's edited copy of a platform-market skill cites: 改自 ClawHub … or 改自 taiyim/<name>."""
    origin = skill_origin(platform_config, skill_id=skill_id, enterprise="")
    upstream = origin["provenance"]
    if upstream is not None and not upstream["edited"]:
        return as_edited(upstream, version=version)  # type: ignore[return-value]
    return platform_provenance(qualified_label(origin["namespace"], origin["name"]), version=version)


def mcp_namespace(origin: str, enterprise: str) -> str:
    return PLATFORM_NAMESPACE if origin != "enterprise" else enterprise


def enterprise_namespace_reader(settings_repo, registry_code: Callable[[str], str | None]) -> EnterpriseNamespace:
    """The enterprise's display name, else its enterprise code, else ""."""
    def read(ctx: TenantContext) -> str:
        try:
            row = settings_repo.get_settings(ctx)
        except Exception:  # noqa: BLE001 - a missing name only affects a display prefix
            row = None
        name = (getattr(row, "enterprise_name", "") or "").strip()
        return name or (registry_code(ctx.tenant_id) or "")

    return read


def app_enterprise_namespace(app) -> EnterpriseNamespace:
    """Cached on the app; without a business DB every enterprise prefix is empty."""
    cached = getattr(app.state, "_enterprise_namespace", None)
    if cached is not None:
        return cached
    settings = app.state.settings
    if not settings.db_url:
        reader: EnterpriseNamespace = lambda _ctx: ""  # noqa: E731
    else:
        from shared.db import PgTenantRouter

        from .routes_me import _registry_code_reader
        from .settings_repository import SettingsRepository

        reader = enterprise_namespace_reader(SettingsRepository(PgTenantRouter(settings.db_url)), _registry_code_reader(settings.admin_db_url))
    app.state._enterprise_namespace = reader
    return reader
