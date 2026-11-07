"""LLM gateway upstream channels and operator-edited model capabilities.

Upstream URL/key live only in the internal gateway (04 §6.7 / D18): keys are
write-only here, never stored by Operator and never returned to any client.
"""
from __future__ import annotations

import ipaddress
import json
import re
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
THINKING_LEVELS: tuple[ThinkingLevel, ...] = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

# Gateway channel types offered for new channels. Existing channels of other
# types are listed and stay editable without changing their type.
CHANNEL_TYPES: dict[int, str] = {
    1: "OpenAI 兼容",
    14: "Anthropic",
    24: "Google Gemini",
    20: "OpenRouter",
    43: "DeepSeek",
    25: "Moonshot",
    35: "MiniMax",
    45: "火山引擎",
    40: "SiliconFlow",
    48: "xAI",
    42: "Mistral",
}

MASK = "********"
_SENSITIVE_HEADER_PARTS = ("authorization", "key", "token", "secret", "cookie", "password", "credential")
_STATUS = {1: "enabled", 2: "manually_disabled", 3: "auto_disabled"}


def _is_sensitive_header(name: str) -> bool:
    normalized = "".join(char for char in name.casefold() if char.isalnum())
    return any(part in normalized for part in _SENSITIVE_HEADER_PARTS)


def _validated_base_url(value: str) -> str:
    value = value.strip().rstrip("/")
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or any(char.isspace() for char in value):
        raise ValueError("上游地址必须是 http(s) 地址")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("上游地址不能包含账号、查询参数或片段")
    hostname = parts.hostname.rstrip(".").casefold()
    if hostname in {"localhost", "localhost.localdomain", "metadata.google.internal"} or hostname.endswith((".localhost", ".local")):
        raise ValueError("上游地址不能指向本机、内网或云 metadata 地址")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("上游地址不能指向本机、内网或保留地址")
    if re.fullmatch(r"\d+(?:\.\d+){3}", hostname):
        raise ValueError("上游地址中的 IPv4 地址无效")
    return value


class GatewayChannelInput(BaseModel):
    """One upstream channel as edited by the operator."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=64)
    channel_type: int = Field(ge=1, description="网关渠道类型（协议）。")
    base_url: str = Field(default="", max_length=512, description="上游地址；留空使用该类型的官方地址。")
    key: str | None = Field(default=None, max_length=16384, repr=False, description="上游 API Key；只写不读，编辑时留空表示不修改。")
    models: list[str] = Field(min_length=1, max_length=500, description="对外提供的模型名。")
    model_mapping: dict[str, str] = Field(default_factory=dict, description="对外模型名 → 上游实际模型名。")
    header_override: dict[str, str] = Field(default_factory=dict, description="附加/覆盖的请求头。")
    param_override: dict[str, Any] = Field(default_factory=dict, description="覆盖的请求体参数。")
    group: str = Field(default="default", min_length=1, max_length=64)
    priority: int = Field(default=0, ge=-1_000_000, le=1_000_000)
    weight: int = Field(default=0, ge=0, le=1_000_000)
    test_model: str | None = Field(default=None, max_length=255)

    @field_validator("name", "group")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("不能为空")
        return value

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, value: str) -> str:
        return _validated_base_url(value)

    @field_validator("key")
    @classmethod
    def _key(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        return value or None

    @field_validator("test_model")
    @classmethod
    def _test_model(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        return value or None

    @field_validator("models")
    @classmethod
    def _models(cls, value: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(item.strip() for item in value if item.strip()))
        if not cleaned:
            raise ValueError("至少填写一个模型")
        if any(len(item) > 255 or "," in item for item in cleaned):
            raise ValueError("模型名不能超过 255 个字符或包含逗号")
        return cleaned

    @field_validator("model_mapping")
    @classmethod
    def _mapping(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {key.strip(): target.strip() for key, target in value.items()}
        if any(not key or not target for key, target in cleaned.items()):
            raise ValueError("模型映射的两端都不能为空")
        return cleaned

    @field_validator("header_override")
    @classmethod
    def _headers(cls, value: dict[str, str]) -> dict[str, str]:
        cleaned = {key.strip(): header for key, header in value.items()}
        for key, header in cleaned.items():
            if not key or any(char.isspace() or char == ":" for char in key):
                raise ValueError(f"请求头名称无效：{key!r}")
            if "\n" in header or "\r" in header:
                raise ValueError(f"请求头 {key} 的值不能换行")
        return cleaned


class GatewayChannelOut(BaseModel):
    """Key-free view of one gateway channel."""

    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    channel_type: int
    channel_type_label: str
    status: Literal["enabled", "manually_disabled", "auto_disabled", "unknown"]
    base_url: str = ""
    models: list[str] = Field(default_factory=list)
    model_mapping: dict[str, str] = Field(default_factory=dict)
    header_override: dict[str, str] = Field(default_factory=dict, description="敏感请求头的值以掩码返回。")
    param_override: dict[str, Any] = Field(default_factory=dict)
    group: str = "default"
    priority: int = 0
    weight: int = 0
    test_model: str | None = None
    response_time_ms: int | None = None
    tested_at: int | None = Field(default=None, description="上次测试时间（Unix 秒）。")


class GatewayChannelTypeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel_type: int
    label: str


class GatewayChannelTestOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool
    seconds: float | None = None
    message: str = ""


class UpstreamModelPreviewInput(BaseModel):
    """Fetch the upstream model list before or after saving a channel."""

    model_config = ConfigDict(extra="forbid")
    channel_id: int | None = Field(default=None, ge=1)
    channel_type: int | None = Field(default=None, ge=1)
    base_url: str = Field(default="", max_length=512)
    key: str | None = Field(default=None, max_length=16384, repr=False)

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, value: str) -> str:
        return _validated_base_url(value)

    @model_validator(mode="after")
    def _source(self) -> "UpstreamModelPreviewInput":
        if self.channel_id is None and (self.channel_type is None or not (self.key or "").strip()):
            raise ValueError("未保存的渠道需要填写类型和 API Key")
        return self


class ModelCapabilitiesInput(BaseModel):
    """Runtime capabilities forwarded to the local Pi model (context, output, thinking, input)."""

    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(default="", max_length=256)
    context_window: int | None = Field(default=None, ge=1024, le=10_000_000)
    max_tokens: int | None = Field(default=None, ge=1, le=10_000_000)
    reasoning: bool
    thinking_mode: Literal["none", "toggle", "effort", "budget"]
    thinking_levels: list[ThinkingLevel] = Field(default_factory=lambda: ["off"])
    thinking_level_map: dict[ThinkingLevel, str | None] = Field(default_factory=dict)
    input: list[Literal["text", "image"]] = Field(default_factory=lambda: ["text"])

    @model_validator(mode="after")
    def _consistent(self) -> "ModelCapabilitiesInput":
        if self.context_window and self.max_tokens and self.max_tokens > self.context_window:
            raise ValueError("最大输出不能超过上下文窗口")
        if "text" not in self.input:
            raise ValueError("模型必须支持文本输入")
        self.input = [mode for mode in ("text", "image") if mode in self.input]
        if not self.reasoning:
            self.thinking_mode = "none"
            self.thinking_levels = ["off"]
            return self
        if self.thinking_mode == "none":
            raise ValueError("支持思考的模型需要选择思考方式")
        levels: list[ThinkingLevel] = [level for level in THINKING_LEVELS if level == "off" or level in self.thinking_levels]
        if len(levels) < 2:
            raise ValueError("支持思考的模型至少开放一个思考档位")
        self.thinking_levels = levels
        return self


def channel_type_options() -> list[GatewayChannelTypeOut]:
    return [GatewayChannelTypeOut(channel_type=key, label=label) for key, label in CHANNEL_TYPES.items()]


def _json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _string_map(raw: Any) -> dict[str, str]:
    return {str(key): value if isinstance(value, str) else json.dumps(value) for key, value in _json_object(raw).items()}


def _int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _int_or_none(value: Any) -> int | None:
    number = _int(value)
    return number if number > 0 else None


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def channel_out(raw: dict[str, Any]) -> GatewayChannelOut:
    headers = {key: MASK if _is_sensitive_header(key) else value for key, value in _string_map(raw.get("header_override")).items()}
    channel_type = _int(raw.get("type"))
    models = _text(raw.get("models"))
    return GatewayChannelOut(
        id=_int(raw.get("id")),
        name=str(raw.get("name") or ""),
        channel_type=channel_type,
        channel_type_label=CHANNEL_TYPES.get(channel_type, f"其他类型（{channel_type}）"),
        status=_STATUS.get(raw.get("status"), "unknown"),  # type: ignore[arg-type]
        base_url=str(raw.get("base_url") or ""),
        models=list(dict.fromkeys(item.strip() for item in models.split(",") if item.strip())),
        model_mapping=_string_map(raw.get("model_mapping")),
        header_override=headers,
        param_override=_json_object(raw.get("param_override")),
        group=str(raw.get("group") or "default"),
        priority=_int(raw.get("priority")),
        weight=_int(raw.get("weight")),
        test_model=_text(raw.get("test_model")) or None,
        response_time_ms=_int_or_none(raw.get("response_time")),
        tested_at=_int_or_none(raw.get("test_time")),
    )


def enabled_channel_models(channels: list[dict[str, Any]]) -> list[str]:
    """Union of the externally visible model names on every enabled channel."""
    names: set[str] = set()
    for channel in channels:
        if channel.get("status") != 1 or not isinstance(channel.get("models"), str):
            continue
        names.update(item.strip() for item in channel["models"].split(",") if item.strip())
    return sorted(names)


def channel_payload(body: GatewayChannelInput, *, original: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build the gateway write body; masked header values keep their stored value."""
    stored = _string_map(original.get("header_override")) if original else {}
    headers: dict[str, str] = {}
    for key, value in body.header_override.items():
        if value == MASK:
            if key not in stored:
                raise ValueError(f"请求头 {key} 需要填写实际值")
            value = stored[key]
        headers[key] = value
    payload: dict[str, Any] = {
        "name": body.name,
        "type": body.channel_type,
        "base_url": body.base_url,
        "models": ",".join(body.models),
        "model_mapping": json.dumps(body.model_mapping, ensure_ascii=False) if body.model_mapping else "",
        "header_override": json.dumps(headers, ensure_ascii=False) if headers else "",
        "param_override": json.dumps(body.param_override, ensure_ascii=False) if body.param_override else "",
        "group": body.group,
        "priority": body.priority,
        "weight": body.weight,
        "test_model": body.test_model or "",
    }
    if body.key:
        payload["key"] = body.key
    return payload


def merged_capabilities(existing: dict[str, Any], body: ModelCapabilitiesInput) -> dict[str, Any]:
    """Replace the runtime capability keys and keep unrelated catalog metadata."""
    result = dict(existing)
    result.pop("input_modalities", None)
    for key in ("context_window", "max_tokens"):
        value = getattr(body, key)
        if value is None:
            result.pop(key, None)
        else:
            result[key] = value
    result.update({
        "reasoning": body.reasoning,
        "thinking_mode": body.thinking_mode,
        "thinking_levels": list(body.thinking_levels),
        "thinking_level_map": {
            level: ((body.thinking_level_map.get(level) or "").strip() or ("none" if level == "off" else level))  # type: ignore[call-overload]
            if level in body.thinking_levels else None
            for level in THINKING_LEVELS
        },
        "input": list(body.input),
    })
    return result
