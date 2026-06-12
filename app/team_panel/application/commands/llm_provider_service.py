"""LLM provider/model configuration service.

DB is the source of truth. On every write that affects provider credentials or
the enabled model set, we re-materialize the enterprise's providers into the
Hermes root config.yaml (one-way DB -> config.yaml) so runtime profiles inherit
them. See agent_gateway.profile_provisioner.materialize_root_providers.
"""
from __future__ import annotations

import uuid

from ...domain.entities import EnterpriseLlmModel, EnterpriseLlmProvider
from ...transactions.uow import UnitOfWork


def _materialize(conn, enterprise_id: str) -> None:
    """Project the enterprise's enabled providers+models into root config.yaml."""
    from agent_gateway.profile_provisioner import materialize_root_providers

    with UnitOfWork(conn) as uow:
        providers = uow.llm_providers().list_by_enterprise(enterprise_id)
        models = uow.llm_models().list_by_enterprise(enterprise_id)
    by_provider: dict[str, list] = {}
    for m in models:
        if m.enabled:
            by_provider.setdefault(m.provider_id, []).append(m)
    payload = []
    for p in providers:
        if not p.enabled:
            continue
        pmodels = by_provider.get(p.id, [])
        default_model = next((m.model_id for m in pmodels if m.is_default),
                             pmodels[0].model_id if pmodels else "")
        payload.append({
            "provider_key": p.provider_key,
            "base_url": p.base_url,
            "api_key": p.api_key,
            "transport": p.transport,
            "default_model": default_model,
            "models": [{"model_id": m.model_id, "context_length": m.context_length}
                       for m in pmodels],
        })
    materialize_root_providers(payload)


def create_provider(conn, enterprise_id: str, data: dict, created_by: str = "") -> str:
    provider = EnterpriseLlmProvider(
        id=f"llmp_{uuid.uuid4().hex[:12]}",
        enterprise_id=enterprise_id,
        provider_key=(data.get("provider_key") or "").strip(),
        display_name=data.get("display_name") or "",
        base_url=data.get("base_url") or "",
        api_key=data.get("api_key") or "",
        transport=data.get("transport") or "openai_chat",
        enabled=bool(data.get("enabled", True)),
        created_by=created_by,
    )
    with UnitOfWork(conn) as uow:
        uow.llm_providers().create(provider)
    _materialize(conn, enterprise_id)
    return provider.id


def update_provider(conn, enterprise_id: str, provider_id: str, data: dict) -> bool:
    with UnitOfWork(conn) as uow:
        repo = uow.llm_providers()
        p = repo.get_by_id(provider_id)
        if p is None or p.enterprise_id != enterprise_id:
            return False
        for field in ("display_name", "base_url", "api_key", "transport"):
            if field in data:
                setattr(p, field, data[field] or "")
        if "enabled" in data:
            p.enabled = bool(data["enabled"])
        repo.update(p)
    _materialize(conn, enterprise_id)
    return True


def delete_provider(conn, enterprise_id: str, provider_id: str) -> bool:
    with UnitOfWork(conn) as uow:
        repo = uow.llm_providers()
        p = repo.get_by_id(provider_id)
        if p is None or p.enterprise_id != enterprise_id:
            return False
        repo.delete(provider_id)
    _materialize(conn, enterprise_id)
    return True


def add_model(conn, enterprise_id: str, provider_id: str, data: dict) -> str | None:
    with UnitOfWork(conn) as uow:
        p = uow.llm_providers().get_by_id(provider_id)
        if p is None or p.enterprise_id != enterprise_id:
            return None
        model = EnterpriseLlmModel(
            id=f"llmm_{uuid.uuid4().hex[:12]}",
            enterprise_id=enterprise_id,
            provider_id=provider_id,
            model_id=(data.get("model_id") or "").strip(),
            label=data.get("label") or "",
            context_length=int(data.get("context_length") or 0),
            enabled=bool(data.get("enabled", True)),
            is_default=bool(data.get("is_default", False)),
        )
        uow.llm_models().create(model)
    _materialize(conn, enterprise_id)
    return model.id


def delete_model(conn, enterprise_id: str, model_id: str) -> bool:
    with UnitOfWork(conn) as uow:
        repo = uow.llm_models()
        m = repo.get_by_id(model_id)
        if m is None or m.enterprise_id != enterprise_id:
            return False
        repo.delete(model_id)
    _materialize(conn, enterprise_id)
    return True


def list_models_flat(conn, enterprise_id: str) -> list[dict]:
    """Enabled models across all enabled providers, for the employee model picker."""
    with UnitOfWork(conn) as uow:
        providers = {p.id: p for p in uow.llm_providers().list_by_enterprise(enterprise_id)}
        models = uow.llm_models().list_by_enterprise(enterprise_id)
    out = []
    for m in models:
        p = providers.get(m.provider_id)
        if p is None or not p.enabled or not m.enabled:
            continue
        out.append({
            "model_uid": m.id,
            "provider_id": p.id,
            "provider_key": p.provider_key,
            "provider_name": p.display_name or p.provider_key,
            "model_id": m.model_id,
            "label": m.label or m.model_id,
            "context_length": m.context_length,
            "is_default": m.is_default,
        })
    return out
