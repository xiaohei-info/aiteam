"""Public model pricing source client (models.dev)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx


class PublicPricingError(RuntimeError):
    pass


@dataclass(frozen=True)
class PublicModelPrice:
    input_usd_per_million: Decimal
    output_usd_per_million: Decimal
    cache_read_usd_per_million: Decimal | None = None
    cache_write_usd_per_million: Decimal | None = None
    source_version: str = "models.dev/api.json"
    display_name: str | None = None
    capabilities: dict[str, Any] = field(default_factory=dict)


class ModelsDevPricingClient:
    _MAX_RESPONSE = 8 * 1024 * 1024

    def __init__(self, url: str = "https://models.dev/api.json", timeout: float = 30.0, transport=None):
        self._url = url
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def close(self) -> None:
        self._client.close()

    def fetch(self) -> dict[str, PublicModelPrice]:
        try:
            with self._client.stream("GET", self._url, headers={"Accept": "application/json"}) as response:
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > self._MAX_RESPONSE:
                        raise PublicPricingError("public pricing response exceeded 8 MiB")
        except PublicPricingError:
            raise
        except httpx.HTTPError as exc:
            raise PublicPricingError(f"public pricing request failed: {exc}") from exc
        if response.status_code < 200 or response.status_code >= 300:
            raise PublicPricingError(f"public pricing request failed with HTTP {response.status_code}")
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise PublicPricingError("public pricing source returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise PublicPricingError("public pricing source returned an invalid object")
        return _flatten_models(payload)


def _flatten_models(payload: dict[str, Any]) -> dict[str, PublicModelPrice]:
    candidates: dict[str, tuple[int, PublicModelPrice]] = {}
    for provider_id in sorted(payload):
        provider = payload[provider_id]
        if not isinstance(provider, dict) or not isinstance(provider.get("models"), dict):
            continue
        for model_key, model in provider["models"].items():
            if not isinstance(model, dict):
                continue
            price = _parse_price(model.get("cost"), model)
            if price is None:
                continue
            model_ids = {str(model_key), str(model.get("id") or "")}
            priority = _provider_priority(provider_id, model_key)
            for model_id in model_ids:
                normalized = _normalize(model_id)
                if not normalized or (normalized in candidates and candidates[normalized][0] <= priority):
                    continue
                candidates[normalized] = (priority, price)
    return {model_id: price for model_id, (_, price) in candidates.items()}


def _parse_price(raw: Any, model: Any = None) -> PublicModelPrice | None:
    if not isinstance(raw, dict):
        return None
    input_price = _decimal(raw.get("input"))
    output_price = _decimal(raw.get("output"))
    if input_price is None or output_price is None or input_price < 0 or output_price < 0:
        return None
    if input_price == 0 and output_price == 0:
        return None
    return PublicModelPrice(
        input_usd_per_million=input_price,
        output_usd_per_million=output_price,
        cache_read_usd_per_million=_decimal(raw.get("cache_read")),
        cache_write_usd_per_million=_decimal(raw.get("cache_write")),
        display_name=_model_display_name(model),
        capabilities=_model_capabilities(model),
    )


_THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def _model_display_name(model: Any) -> str | None:
    value = model.get("name") if isinstance(model, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:256] or None


def _model_capabilities(model: Any) -> dict[str, Any]:
    """Normalize models.dev reasoning metadata to the levels understood by Pi."""
    if not isinstance(model, dict) or not isinstance(model.get("reasoning"), bool):
        return {}
    reasoning = model["reasoning"]
    levels = ["off"]
    options = model.get("reasoning_options")
    if reasoning and isinstance(options, list):
        effort_values: list[str] = []
        has_toggle = False
        for option in options:
            if not isinstance(option, dict):
                continue
            option_type = option.get("type")
            if option_type == "toggle":
                has_toggle = True
            if option_type == "effort" and isinstance(option.get("values"), list):
                effort_values.extend(
                    value.strip().lower()
                    for value in option["values"]
                    if isinstance(value, str) and value.strip()
                )
        if effort_values:
            levels.extend(_canonical_thinking_levels(effort_values))
        elif has_toggle:
            # A toggle has one enabled state; represent it by one standard
            # enabled level so Manager and Agent expose the same two states.
            levels.append("high")
        else:
            levels.extend(("minimal", "low", "medium", "high"))
    elif reasoning:
        levels.extend(("minimal", "low", "medium", "high"))

    levels = list(dict.fromkeys(levels))
    thinking_map = {
        level: ("none" if level == "off" else level if level in levels else None)
        for level in _THINKING_LEVELS
    }
    return {
        "reasoning": reasoning,
        "thinking_levels": levels,
        "thinking_level_map": thinking_map,
    }


def _canonical_thinking_levels(values: list[str]) -> list[str]:
    aliases = {"none": "off"}
    return [
        aliases.get(value, value)
        for value in values
        if aliases.get(value, value) in _THINKING_LEVELS
    ]


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return result if result.is_finite() else None


def _normalize(value: str) -> str:
    return value.strip().lower()


def _provider_priority(provider_id: str, model_id: str) -> int:
    model = _normalize(model_id)
    preferred = (
        ("claude", ("anthropic",)),
        ("gemini", ("google",)),
        ("gpt-", ("openai",)),
        ("o1", ("openai",)),
        ("o3", ("openai",)),
        ("o4", ("openai",)),
        ("deepseek", ("deepseek",)),
        ("minimax", ("minimax",)),
        ("kimi", ("moonshotai", "moonshot")),
        ("qwen", ("alibaba",)),
        ("glm", ("zhipuai", "zai")),
        ("mistral", ("mistral",)),
        ("grok", ("xai",)),
    )
    for index, (prefix, providers) in enumerate(preferred):
        if model.startswith(prefix) and any(provider in provider_id.lower() for provider in providers):
            return index
    return 100 + (0 if provider_id in {"openai", "anthropic", "google", "deepseek", "minimax"} else 1)
