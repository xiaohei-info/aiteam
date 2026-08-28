"""Public model pricing source client (models.dev)."""
from __future__ import annotations

import json
from dataclasses import dataclass
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
            price = _parse_price(model.get("cost"))
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


def _parse_price(raw: Any) -> PublicModelPrice | None:
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
    )


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
